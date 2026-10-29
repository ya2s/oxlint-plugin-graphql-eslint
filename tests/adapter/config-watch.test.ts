import { cpSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigWatchCache,
  getConfigFingerprint,
  getConfigFingerprintCallCount,
  invalidateIfConfigChanged,
} from "../../src/adapter/config-watch.js";
import { runParseStalenessScenario } from "./support/run-parse-staleness.js";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "gql-watch-"));
  writeFileSync(join(dir, "graphql.config.js"), 'export default { schema: "./schema.graphql" };\n');
  writeFileSync(join(dir, "schema.graphql"), "type Query { a: Int }\n");
  return dir;
}

describe("getConfigFingerprint", () => {
  it("is stable while nothing changes", () => {
    const dir = project();
    const filePath = join(dir, "app.ts");

    expect(getConfigFingerprint(filePath)).toBe(getConfigFingerprint(filePath));
  });

  it("changes when the schema file is touched", () => {
    const dir = project();
    const filePath = join(dir, "app.ts");
    const before = getConfigFingerprint(filePath);

    const later = new Date(Date.now() + 2000);
    utimesSync(join(dir, "schema.graphql"), later, later);

    expect(getConfigFingerprint(filePath)).not.toBe(before);
  });

  it("changes when the graphql config file is touched", () => {
    const dir = project();
    const filePath = join(dir, "app.ts");
    const before = getConfigFingerprint(filePath);

    const later = new Date(Date.now() + 2000);
    utimesSync(join(dir, "graphql.config.js"), later, later);

    expect(getConfigFingerprint(filePath)).not.toBe(before);
  });

  it("ignores unrelated files", () => {
    const dir = project();
    const filePath = join(dir, "app.ts");
    const before = getConfigFingerprint(filePath);

    cpSync(join(dir, "schema.graphql"), join(dir, "other.graphql"));

    expect(getConfigFingerprint(filePath)).toBe(before);
  });
});

describe("parseDocuments in a long-lived process", () => {
  // `@graphql-eslint/eslint-plugin@4.4.1` caches its loaded graphql-config in a module-level
  // singleton that is bypassed only under `NODE_ENV=test` (see graphql-config.js). vitest sets
  // `NODE_ENV=test` on itself, so calling `parseDocuments` in-process here would never observe
  // the staleness this test exists to catch. Instead this spawns a genuine `node` subprocess
  // with `NODE_ENV=production` pinned and performs both calls, and the schema edit between them,
  // inside that ONE subprocess -- see support/parse-staleness-runner.ts and
  // support/run-parse-staleness.ts for the mechanics.
  //
  // `@graphql-eslint/eslint-plugin` also has a second, independent cache: `esm/cache.js`'s
  // `ModuleCache`, used by `esm/schema.js` to memoize the loaded `GraphQLSchema` for up to 10
  // seconds. That means a schema edit becomes visible to a fresh `parseDocuments` call as soon
  // as invalidateIfConfigChanged clears OUR cache, but the actual graphql-eslint internals
  // underneath can still serve the old schema object for up to 10s after it was first loaded.
  // This test waits 11s past the edit so both caches have had a chance to give way, isolating
  // what this task's own fix controls (see the report for the sub-10s case, which is expected to
  // still be stale, and for why no amount of cache-clearing in this package can shorten that
  // window).
  //
  // This test runs with `NODE` deliberately unset (see run-parse-staleness.ts), which is the
  // "clean" case. See the next test for the `NODE`-set case, which needs
  // parse.ts's `parseForESLintWithCacheMode` to behave the same way.
  //
  // Both run the subprocess with `--lsp` in its argv (see run-parse-staleness.ts): a one-shot CLI
  // run deliberately keeps the first schema for the whole process instead.
  it(
    "re-reads the schema after it changes, without a process restart",
    () => {
      const dir = project();
      const schemaPath = join(dir, "schema.graphql");

      const { first, second } = runParseStalenessScenario({ projectDir: dir, schemaPath, waitMs: 11_000 });

      expect(first).toEqual(["a"]);
      expect(second).toEqual(["a", "b"]);
    },
    20_000,
  );

  // `pnpm run <script>`/`pnpm exec` set a bare `NODE` env var to the node binary path, which
  // `esm/cache.js`'s `ModuleCache.get` treats as "never expire" (see
  // parse.ts's `parseForESLintWithCacheMode` doc comment for the exact upstream
  // expression). This simulates that launch path by forcing `NODE` to stay set for the whole
  // subprocess, and asserts the schema edit is STILL observed after the same 11s wait. Without
  // the workaround in parse.ts, this test fails (the cached schema is returned forever, so
  // `second` stays `["a"]` even after 11s) -- verified directly by temporarily removing the
  // workaround and re-running this test before writing this comment; see Task 11's follow-up
  // report for that evidence.
  it(
    "re-reads the schema after it changes, even with NODE set (pnpm exec/pnpm run launch path)",
    () => {
      const dir = project();
      const schemaPath = join(dir, "schema.graphql");

      const { first, second } = runParseStalenessScenario({
        projectDir: dir,
        schemaPath,
        waitMs: 11_000,
        nodeEnvValue: process.execPath,
      });

      expect(first).toEqual(["a"]);
      expect(second).toEqual(["a", "b"]);
    },
    20_000,
  );
});

describe("invalidateIfConfigChanged", () => {
  beforeEach(() => {
    clearConfigWatchCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The behaviour this whole block exists for: `parseDocuments` calls this before its own cache
  // lookup, and every enabled rule calls `parseDocuments` separately for the same file (see
  // rule-factory.ts's `Program()`), so without a memo the fingerprint -- a directory walk plus
  // `existsSync`/`readFileSync`/`statSync` -- is recomputed once per (rule x file). See the
  // function's own doc comment for the measurement.
  it("computes the fingerprint once for repeated calls within the TTL", () => {
    const dir = project();
    const filePath = join(dir, "app.ts");
    let changes = 0;

    for (let i = 0; i < 33; i++) invalidateIfConfigChanged(filePath, () => changes++);

    expect(getConfigFingerprintCallCount()).toBe(1);
    expect(changes).toBe(1);
  });

  it("memoizes per directory, not globally", () => {
    const a = join(project(), "app.ts");
    const b = join(project(), "app.ts");

    invalidateIfConfigChanged(a, () => {});
    invalidateIfConfigChanged(b, () => {});
    invalidateIfConfigChanged(a, () => {});
    invalidateIfConfigChanged(b, () => {});

    expect(getConfigFingerprintCallCount()).toBe(2);
  });

  it("recomputes once the TTL has elapsed", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const filePath = join(project(), "app.ts");

    invalidateIfConfigChanged(filePath, () => {});
    vi.advanceTimersByTime(1_001);
    invalidateIfConfigChanged(filePath, () => {});

    expect(getConfigFingerprintCallCount()).toBe(2);
  });

  // The memo must not cost the language server a schema edit, only delay noticing it by at most
  // the TTL -- which is why the TTL sits far below the ~10s floor graphql-eslint's own schema
  // cache already imposes (see this module's doc comment).
  it("still detects a schema change after the TTL has elapsed", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const dir = project();
    const filePath = join(dir, "app.ts");
    let changes = 0;

    invalidateIfConfigChanged(filePath, () => changes++);
    const later = new Date(Date.now() + 2000);
    utimesSync(join(dir, "schema.graphql"), later, later);
    vi.advanceTimersByTime(1_001);
    invalidateIfConfigChanged(filePath, () => changes++);

    expect(changes).toBe(2);
  });

  it("does not detect a schema change while the TTL is still running", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const dir = project();
    const filePath = join(dir, "app.ts");
    let changes = 0;

    invalidateIfConfigChanged(filePath, () => changes++);
    const later = new Date(Date.now() + 2000);
    utimesSync(join(dir, "schema.graphql"), later, later);
    vi.advanceTimersByTime(999);
    invalidateIfConfigChanged(filePath, () => changes++);

    expect(changes).toBe(1);
  });
});
