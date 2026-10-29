import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_MODE_ENV,
  clearParseCache,
  getParseCallCount,
  parseDocuments,
} from "../../src/adapter/parse.js";
import type { ParserServices } from "../../src/adapter/types.js";

const projectDir = fileURLToPath(new URL("../fixtures/project", import.meta.url));
const filePath = join(projectDir, "app.ts");

const code = ["const q = gql`", "  query User {", "    user { id }", "  }", "`;", ""].join("\n");

describe("parseDocuments", () => {
  beforeEach(() => {
    clearParseCache();
  });

  it("parses each embedded document into a GraphQL ESTree program", () => {
    const parsed = parseDocuments({ code, filePath });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe("parsed");
    if (parsed[0]!.kind !== "parsed") return;
    expect(parsed[0]!.ast.type).toBe("Program");
  });

  it("loads the schema from the on-disk graphql-config", () => {
    const parsed = parseDocuments({ code, filePath });

    if (parsed[0]!.kind !== "parsed") throw new Error("expected a parsed document");
    expect(parsed[0]!.services.schema?.getQueryType()?.name).toBe("Query");
  });

  it("builds the schema from settings when schemaSdl is given", () => {
    const parsed = parseDocuments({
      code: "const q = gql`{ a }`;\n",
      filePath: "/tmp/no-config/app.ts",
      schemaSdl: "type Query { a: Int }",
    });

    if (parsed[0]!.kind !== "parsed") throw new Error("expected a parsed document");
    expect(parsed[0]!.services.schema?.getQueryType()?.getFields().a).toBeDefined();
  });

  it("returns a parse error instead of throwing on invalid GraphQL", () => {
    const parsed = parseDocuments({ code: "const q = gql`query {`;\n", filePath });

    expect(parsed[0]!.kind).toBe("error");
    if (parsed[0]!.kind !== "error") return;
    expect(parsed[0]!.error.message).toContain("Syntax Error");
    expect(parsed[0]!.error.line).toBe(1);
  });

  it("parses successfully with a null schema when no graphql-config exists (parity with graphql-eslint)", () => {
    // graphql-eslint does not require a schema to be configured up front: schema availability is
    // enforced per rule at rule-execution time (`requireGraphQLSchema` / `requireGraphQLOperations`),
    // not by the parser. A project with no graphql-config at all must still parse.
    const parsed = parseDocuments({
      code: "const q = gql`{ a }`;\n",
      filePath: "/tmp/no-graphql-config/app.ts",
    });

    expect(parsed[0]!.kind).toBe("parsed");
    if (parsed[0]!.kind !== "parsed") return;
    expect(parsed[0]!.services.schema).toBeNull();
  });

  it("throws when the graphql-config schema fails to load", () => {
    const brokenSchemaDir = join(projectDir, "..", "broken-schema");

    expect(() =>
      parseDocuments({
        code: "const q = gql`{ a }`;\n",
        filePath: join(brokenSchemaDir, "app.ts"),
      }),
    ).toThrow(/Unable to find any GraphQL type definitions/);
  });

  it("loads a TypeScript graphql config file", () => {
    const tsProject = join(projectDir, "ts-config");
    const parsed = parseDocuments({ code, filePath: join(tsProject, "app.ts") });

    if (parsed[0]!.kind !== "parsed") throw new Error("expected a parsed document");
    expect(parsed[0]!.services.schema?.getQueryType()?.name).toBe("Query");
  });

  it("parses a file only once even when called repeatedly", () => {
    parseDocuments({ code, filePath });
    const afterFirst = getParseCallCount();
    parseDocuments({ code, filePath });
    parseDocuments({ code, filePath });

    expect(getParseCallCount()).toBe(afterFirst);
  });

  it("re-parses when the file content changes", () => {
    parseDocuments({ code, filePath });
    const afterFirst = getParseCallCount();
    parseDocuments({ code: code.replace("id", "name"), filePath });

    expect(getParseCallCount()).toBe(afterFirst + 1);
  });

  it("keys the cache by schemaSdl, not just filePath and code", () => {
    const sameCode = "const q = gql`{ a }`;\n";
    const sameFilePath = "/tmp/no-config/app.ts";

    const first = parseDocuments({
      code: sameCode,
      filePath: sameFilePath,
      schemaSdl: "type Query { a: Int }",
    });
    const second = parseDocuments({
      code: sameCode,
      filePath: sameFilePath,
      schemaSdl: "type Query { a: String }",
    });

    if (first[0]!.kind !== "parsed") throw new Error("expected a parsed document");
    if (second[0]!.kind !== "parsed") throw new Error("expected a parsed document");
    expect(first[0]!.services.schema?.getQueryType()?.getFields().a?.type.toString()).toBe("Int");
    expect(second[0]!.services.schema?.getQueryType()?.getFields().a?.type.toString()).toBe("String");
  });
});

// graphql-eslint's `ModuleCache` (esm/cache.js) memoizes the loaded schema and sibling operations
// keyed by the graphql-config `schema`/`documents` pointers, and expires each entry 10 seconds
// after it was loaded unless `process.env.NODE` is set. Reference equality of `services.schema`
// and `services.siblingOperations` across calls tells whether the second call reloaded them.
describe("graphql-eslint schema/operations cache lifetime", () => {
  const savedArgv = process.argv;
  const savedOverride = process.env[CACHE_MODE_ENV];

  function project(): string {
    // Absolute pointers: `ModuleCache` keys are the raw pointer strings, so relative ones would
    // collide across the temp projects of different tests in this process.
    const dir = mkdtempSync(join(tmpdir(), "gql-cache-mode-"));
    mkdirSync(join(dir, "ops"));
    writeFileSync(
      join(dir, "graphql.config.json"),
      JSON.stringify({ schema: join(dir, "schema.graphql"), documents: join(dir, "ops/*.graphql") }),
    );
    writeFileSync(join(dir, "schema.graphql"), "type Query { a: Int }\n");
    writeFileSync(join(dir, "ops/q.graphql"), "query Q { a }\n");
    return join(dir, "app.ts");
  }

  function servicesAfter(filePath: string, elapsedMs: number): [ParserServices, ParserServices] {
    const code = "const q = gql`{ a }`;\n";
    const first = parseDocuments({ code, filePath });
    vi.advanceTimersByTime(elapsedMs);
    clearParseCache();
    const second = parseDocuments({ code, filePath });
    if (first[0]?.kind !== "parsed" || second[0]?.kind !== "parsed") throw new Error("expected parsed documents");
    return [first[0].services, second[0].services];
  }

  beforeEach(() => {
    clearParseCache();
    vi.useFakeTimers({ toFake: ["hrtime"] });
    delete process.env[CACHE_MODE_ENV];
  });

  afterEach(() => {
    vi.useRealTimers();
    process.argv = savedArgv;
    if (savedOverride === undefined) delete process.env[CACHE_MODE_ENV];
    else process.env[CACHE_MODE_ENV] = savedOverride;
  });

  it("loads the schema and operations once for a CLI run longer than 10 seconds", () => {
    const [first, second] = servicesAfter(project(), 11_000);

    expect(first.siblingOperations).not.toMatchObject({ available: false });
    expect(second.schema).toBe(first.schema);
    expect(second.siblingOperations).toBe(first.siblingOperations);
  });

  it("keeps the CLI cache even when NODE is unset", () => {
    const savedNode = process.env.NODE;
    delete process.env.NODE;
    try {
      const [first, second] = servicesAfter(project(), 11_000);

      expect(second.schema).toBe(first.schema);
      expect(process.env.NODE).toBeUndefined();
    } finally {
      if (savedNode !== undefined) process.env.NODE = savedNode;
    }
  });

  it("reloads them after 10 seconds under the language server (--lsp), even with NODE set", () => {
    process.argv = [...savedArgv, "--lsp"];
    const savedNode = process.env.NODE;
    process.env.NODE = process.execPath;
    try {
      const [first, second] = servicesAfter(project(), 11_000);

      expect(second.schema).not.toBe(first.schema);
      expect(second.siblingOperations).not.toBe(first.siblingOperations);
      expect(process.env.NODE).toBe(process.execPath);
    } finally {
      if (savedNode === undefined) delete process.env.NODE;
      else process.env.NODE = savedNode;
    }
  });

  it("keeps them within 10 seconds under the language server", () => {
    process.argv = [...savedArgv, "--lsp"];
    const [first, second] = servicesAfter(project(), 9_000);

    expect(second.schema).toBe(first.schema);
  });

  it(`lets ${CACHE_MODE_ENV}=ttl force the language-server behaviour`, () => {
    process.env[CACHE_MODE_ENV] = "ttl";
    const [first, second] = servicesAfter(project(), 11_000);

    expect(second.schema).not.toBe(first.schema);
  });

  it(`lets ${CACHE_MODE_ENV}=persistent force the CLI behaviour under --lsp`, () => {
    process.argv = [...savedArgv, "--lsp"];
    process.env[CACHE_MODE_ENV] = "persistent";
    const [first, second] = servicesAfter(project(), 11_000);

    expect(second.schema).toBe(first.schema);
  });

  it(`rejects an unknown ${CACHE_MODE_ENV} value`, () => {
    process.env[CACHE_MODE_ENV] = "forever";

    expect(() => parseDocuments({ code: "const q = gql`{ a }`;\n", filePath: project() })).toThrow(
      /OXLINT_GRAPHQL_ESLINT_CACHE.*"forever"/,
    );
  });
});
