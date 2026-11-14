import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";
import { rules } from "../../src/rules.js";
import { toOxlintRule } from "../../src/adapter/rule-factory.js";

RuleTester.describe = describe;
RuleTester.it = it;

const projectFile = join(fileURLToPath(new URL("../fixtures/project", import.meta.url)), "app.ts");

const ruleTester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

ruleTester.run("no-anonymous-operations", rules["no-anonymous-operations"]!, {
  valid: [
    { code: "const a = 1;\n", filename: projectFile },
    { code: "const q = gql`query User { user { id } }`;\n", filename: projectFile },
  ],
  invalid: [
    {
      name: "anonymous operation inside a gql template",
      code: ["const q = gql`", "  query {", "    user { id }", "  }", "`;", ""].join("\n"),
      filename: projectFile,
      errors: [{ message: "Anonymous GraphQL operations are forbidden. Make sure to name your query!", line: 2 }],
    },
    {
      // The rule reports with `messageId` + `data`, both forwarded to oxlint untouched (see
      // rule-factory.ts), so a `messageId`/`data` assertion works the same as under ESLint.
      name: "asserting by messageId and data",
      code: ["const q = gql`", "  mutation {", "    user { id }", "  }", "`;", ""].join("\n"),
      filename: projectFile,
      errors: [{ messageId: "no-anonymous-operations", data: { operation: "mutation" }, line: 2 }],
    },
  ],
});

describe("rule error wrapping", () => {
  it("reports the rule id and the file path when a rule throws", () => {
    const exploding = toOxlintRule("exploding", {
      meta: {},
      create() {
        throw new Error("kaboom");
      },
    });

    const visitor = (exploding as { createOnce(context: unknown): { Program(): void } }).createOnce({
      sourceCode: { text: "const q = gql`{ user { id } }`;\n" },
      physicalFilename: projectFile,
      settings: {},
      options: [],
      report: () => {},
    });

    expect(() => visitor.Program()).toThrow(/rule "exploding" failed on .*app\.ts: kaboom/);

    // A thrown error's `.stack` (not just `.message`) is what a consumer actually sees — e.g.
    // an uncaught-exception logger prints `.stack`, whose first line is `${name}: ${message}`
    // only when nothing has overwritten it. This previously broke silently: the wrapper set
    // `wrapped.stack = error.stack`, which put the *original* graphql-eslint error's message
    // back on top of `.stack`, so the "rule ... failed on ..." wrapper text never appeared
    // anywhere a consumer would actually look, even though `.message` alone (asserted above)
    // still looked correct.
    let caught: unknown;
    try {
      visitor.Program();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const thrown = caught as Error;
    expect(thrown.stack).toContain('rule "exploding" failed on');
    expect(thrown.stack).toContain("kaboom");
    expect((thrown.cause as Error | undefined)?.message).toBe("kaboom");
  });
});
