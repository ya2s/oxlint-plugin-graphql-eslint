/**
 * Runs inside its OWN subprocess, spawned by run-parse-staleness.ts with `NODE_ENV=production`
 * pinned explicitly (not inherited from whatever the parent test runner happens to set) and
 * `NODE` deliberately unset (see run-parse-staleness.ts's doc comment for why).
 *
 * Why a subprocess at all, and why NODE_ENV matters: `@graphql-eslint/eslint-plugin@4.4.1`
 * caches its loaded graphql-config in a module-level singleton
 * (`esm/graphql-config.js`: `let graphQLConfig; ... if (process.env.NODE_ENV !== "test" &&
 * graphQLConfig) return graphQLConfig;`). `vitest` sets `NODE_ENV=test` on itself, which makes
 * that singleton reload on every call — so a plain in-process vitest test cannot observe the
 * staleness a long-lived process (like the oxc language server) actually experiences. Only a
 * fresh subprocess with `NODE_ENV` explicitly pinned away from `"test"` reproduces it. See
 * conformance/env.ts for the same technique applied to a different graphql-eslint NODE_ENV
 * branch.
 *
 * Argv: `<projectDir> <schemaGraphqlPath> <waitMs> --lsp` (`--lsp` puts parse.ts in
 * language-server cache mode; see run-parse-staleness.ts). Performs, all within this one process (so
 * module-level state persists across the two calls, as it would across two edits in a live
 * language server):
 *
 *   1. `parseDocuments()` against `<projectDir>/app.ts` — the baseline parse.
 *   2. Overwrites `schemaGraphqlPath` with a schema that adds field `b`, and bumps its mtime
 *      forward so `getConfigFingerprint` sees a change.
 *   3. Waits `waitMs` milliseconds (see run-parse-staleness.ts for why this needs to be >10s to
 *      observe the FIXED behavior, not just the bug).
 *   4. `parseDocuments()` again against the same file, unchanged `code`.
 *
 * Prints `{ first: string[], second: string[] }` (each call's Query field names) as JSON on
 * stdout.
 */
import { utimesSync, writeFileSync } from "node:fs";
import { parseDocuments } from "../../../src/adapter/parse.js";

const [, , projectDir, schemaPath, waitMsRaw] = process.argv;
if (!projectDir || !schemaPath || waitMsRaw === undefined) {
  throw new Error("usage: parse-staleness-runner.ts <projectDir> <schemaGraphqlPath> <waitMs>");
}
const waitMs = Number(waitMsRaw);

const filePath = `${projectDir}/app.ts`;
const code = "const q = gql`{ a }`;\n";

function fieldNames(documents: ReturnType<typeof parseDocuments>): string[] {
  const first = documents[0];
  if (!first || first.kind !== "parsed") throw new Error("expected a parsed document");
  const fields = first.services.schema?.getQueryType()?.getFields();
  return fields ? Object.keys(fields) : [];
}

const first = fieldNames(parseDocuments({ code, filePath }));

writeFileSync(schemaPath, "type Query { a: Int\n b: Int }\n");
const later = new Date(Date.now() + 2000);
utimesSync(schemaPath, later, later);

if (waitMs > 0) await new Promise((res) => setTimeout(res, waitMs));

const second = fieldNames(parseDocuments({ code, filePath }));

process.stdout.write(JSON.stringify({ first, second }));
