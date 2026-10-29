/**
 * Keeps `parseDocuments`'s own cache (parse.ts) honest in a long-lived process: without this, a
 * schema or graphql-config edit is invisible to it forever, since the cache is keyed only by
 * `filePath`/`code`/`schemaSdl`, none of which change when a *different* file on disk changes.
 *
 * This is what makes editor support (the oxc language server, `oxlint --lsp`) work at all for a
 * long-lived process instead of just the one-shot CLI. The real, current situation, combined
 * with parse.ts's `parseForESLintWithCacheMode` in its language-server (`ttl`) mode:
 *
 * 1. Editing the CONTENT of an already-configured schema file (same path, new text) does NOT
 *    need a language server restart. This module's cache-clear (via the fingerprint below) lets
 *    a fresh `parseDocuments` call through immediately; that call reaches
 *    `@graphql-eslint/eslint-plugin`'s own schema cache (esm/cache.js's `ModuleCache`, used by
 *    esm/schema.js), which expires 10 seconds after each load. So the edit becomes visible
 *    automatically, typically within ~10 seconds of the edit, with no restart required.
 *
 * 2. That 10-second expiry is ONLY reliable because of a workaround, not for free. `ModuleCache`
 *    actually reads `if (process.env.NODE || process.hrtime(lastSeen)[0] < settings.lifetime)
 *    return result;` -- `process.env.NODE` (almost certainly an upstream typo for `NODE_ENV`)
 *    makes the cache immortal whenever `NODE` is set to any truthy string, and `pnpm run
 *    <script>`/`pnpm exec` -- a common way to launch a language server in a pnpm-managed project
 *    -- always sets a bare `NODE` env var to the node binary path. Verified directly: without a
 *    workaround, a schema-content edit under `NODE` set is NEVER observed, even after 11+
 *    seconds, only a restart fixes it. Under `--lsp`, `parseForESLintWithCacheMode` deletes
 *    `process.env.NODE` around each synchronous `parseForESLint` call specifically to restore
 *    case 1's "no restart needed, ~10s latency" behavior even when `NODE` is set.
 *
 *    The one-shot CLI does the opposite on purpose: it forces `NODE` truthy so the schema and
 *    sibling operations are loaded once per process, since nothing is edited mid-run. Points 1
 *    and 2 therefore describe the language server only. See `parseForESLintWithCacheMode`'s doc
 *    comment for how the two are told apart and how to override it.
 *
 * 3. Editing graphql.config.* itself so it points at a *different* schema file (its `schema`
 *    pointer changes, a `projects` entry is added/removed/renamed, or the config file is moved)
 *    STILL requires a language server restart -- nothing in this module (or elsewhere in this
 *    plugin) fixes that. This fingerprint does detect that edit (the config file's own mtime is
 *    always included) and correctly clears this module's cache, but
 *    `@graphql-eslint/eslint-plugin`'s OWN module-level `graphQLConfig` singleton
 *    (esm/graphql-config.js) is never rebuilt within a process once set, so the next real parse
 *    still asks the *stale* GraphQLConfig object for the file's project, which still returns the
 *    *old* schema pointer. Verified directly: even 11+ seconds after such an edit, in a process
 *    that never restarts, the old schema is still what gets used. Re-importing graphql-eslint's
 *    parser module with a cache-busting query string (a way to defeat this singleton that was
 *    considered) does not work: `@graphql-eslint/eslint-plugin`'s package.json has no matching
 *    `exports` entry for a query-string-suffixed subpath, so the import simply fails to resolve.
 *
 * See tests/adapter/config-watch.test.ts's "re-reads the schema" tests (both the plain case and
 * the `NODE`-set case) for the measurements behind all of the above, and the README's "Editor
 * support" section for how this reads to an end user.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CONFIG_FILE_NAMES = [
  "graphql.config.ts",
  "graphql.config.js",
  "graphql.config.mjs",
  "graphql.config.cjs",
  "graphql.config.json",
  "graphql.config.yaml",
  "graphql.config.yml",
  ".graphqlrc",
  ".graphqlrc.ts",
  ".graphqlrc.js",
  ".graphqlrc.json",
  ".graphqlrc.yaml",
  ".graphqlrc.yml",
  "package.json",
];

const fingerprints = new Map<string, string>();
const checkedAt = new Map<string, number>();
let fingerprintCallCount = 0;

/**
 * Deliberately far below the ~10s floor `@graphql-eslint/eslint-plugin`'s own schema cache
 * already imposes on how fast a schema edit can become visible (see this module's doc comment,
 * point 1). At this length the memo in `invalidateIfConfigChanged` is invisible in the editor,
 * while still collapsing the per-(rule x file) storm of fs calls that one lint pass makes.
 */
const FINGERPRINT_TTL_MS = 1_000;

/** Test-only instrumentation, mirroring parse.ts's `clearParseCache`/`getParseCallCount`: lets a
 *  test prove the fingerprint is computed once per directory per TTL rather than once per call. */
export function clearConfigWatchCache(): void {
  fingerprints.clear();
  checkedAt.clear();
  fingerprintCallCount = 0;
}

export function getConfigFingerprintCallCount(): number {
  return fingerprintCallCount;
}

/**
 * A fingerprint of `filePath`'s graphql-config and the schema file(s) it points at, built from
 * mtimes only (no parsing). Two calls return the same string iff nothing relevant on disk has
 * changed since. See `invalidateIfConfigChanged`, the only real consumer: it stores the previous
 * fingerprint per directory and clears the parse cache when this changes.
 */
export function getConfigFingerprint(filePath: string): string {
  fingerprintCallCount += 1;
  const parts: string[] = [];

  for (const configPath of findConfigFiles(filePath)) {
    parts.push(`${configPath}:${mtime(configPath)}`);
    for (const schemaPath of schemaFilesOf(configPath)) {
      parts.push(`${schemaPath}:${mtime(schemaPath)}`);
    }
  }

  return parts.join("|");
}

/**
 * Calls `onChange` (expected to clear the parse cache) the first time this is called for a given
 * directory, and again whenever `getConfigFingerprint` for `filePath` differs from the last
 * value seen for that directory.
 *
 * The fingerprint is recomputed at most once per `FINGERPRINT_TTL_MS` per directory, because it
 * is NOT the cheap "just an mtime comparison" an earlier version of this comment claimed, and it
 * is called far more often than the call site suggests: `parseDocuments` runs it *before* its own
 * cache lookup, and every enabled rule calls `parseDocuments` separately for the same file (see
 * rule-factory.ts's `Program()`), so an un-memoized run happens once per (rule x file). Each one
 * walks up the directory tree `existsSync`-ing 14 config file names per level, then reads and
 * regex-scans the config it finds and `statSync`s every schema path in it.
 *
 * Measured on a 300-file fixture (150 carrying a `gql` template) with the 33-rule
 * `operations-recommended` preset: 9,900 un-memoized calls costing 1,333ms -- ~75% of the
 * plugin's entire JS-side cost and the largest single item in the profile by a wide margin, ahead
 * of GraphQL parsing (247ms) and all 33 rules' visitor runs combined (197ms). Memoizing takes
 * that to 27ms, and the whole `oxlint` run from 2.10s to 0.85s, with byte-identical diagnostics.
 *
 * The TTL costs at most `FINGERPRINT_TTL_MS` of extra staleness in a language server, on top of
 * the ~10s that graphql-eslint's own schema cache already imposes (see this module's doc comment,
 * point 1) -- so it does not change any of the editor behaviour described there.
 */
export function invalidateIfConfigChanged(filePath: string, onChange: () => void): void {
  const key = dirname(resolve(filePath));

  const lastCheck = checkedAt.get(key);
  // `performance.now()` rather than `Date.now()`: monotonic, so a system clock adjustment mid-run
  // cannot make the memo look arbitrarily fresh (or stale) for the rest of the process.
  const now = performance.now();
  if (lastCheck !== undefined && now - lastCheck < FINGERPRINT_TTL_MS) return;
  checkedAt.set(key, now);

  const current = getConfigFingerprint(filePath);
  if (fingerprints.get(key) !== current) {
    fingerprints.set(key, current);
    onChange();
  }
}

function findConfigFiles(filePath: string): string[] {
  let dir = dirname(resolve(filePath));
  const found: string[] = [];

  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) found.push(candidate);
    }
    if (found.length > 0) return found;

    const parent = dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/**
 * Scans a config file's raw text for quoted paths ending in a schema-like extension. Crude by
 * design: a real parse would need to run each config loader (JS/TS/JSON/YAML) and resolve
 * graphql-config's own project/extends semantics, all of which this function must stay fast and
 * synchronous enough to run on every parse.
 *
 * It both undershoots and overshoots, and neither is fixed:
 *
 * - Undershoot (misses a real schema path, so an edit to that file is not detected until
 *   graphql-eslint's own eventual cache expiry -- see the module doc comment above -- rather
 *   than being reacted to right away): glob patterns (`"./schema/**\/*.graphql"` never resolves
 *   to any `existsSync` candidate, so a schema split across multiple files via a glob is
 *   invisible); and any schema path that isn't a literal quoted string in a JS/TS config --
 *   computed or concatenated paths (`path.join(__dirname, "schema.graphql")`, a template
 *   literal, an imported constant) are invisible to a text-only regex scan.
 * - Overshoot (fingerprints a file that isn't actually this project's schema, so an edit to it
 *   triggers an unnecessary cache clear -- harmless, just a wasted re-parse): the regex matches
 *   ANY quoted path with a schema-like extension anywhere in the file's text, with no awareness
 *   of which JSON/JS key it sits under. In particular, when `package.json` is the discovered
 *   config file (i.e. it carries a `"graphql"` field), an unrelated field like
 *   `"someToolConfig": "./unrelated-config.json"` matches the extension pattern just as well and
 *   gets swept into the fingerprint, so editing that unrelated file also invalidates the cache.
 */
function schemaFilesOf(configPath: string): string[] {
  let content: string;
  try {
    content = statSync(configPath).isFile() ? readFileSync(configPath, "utf8") : "";
  } catch {
    return [];
  }

  const matches = content.matchAll(/["'`]([^"'`\s]+\.(?:graphql|graphqls|gql|json))["'`]/g);
  const dir = dirname(configPath);
  const paths: string[] = [];
  for (const match of matches) {
    const candidate = resolve(dir, match[1]!);
    if (existsSync(candidate)) paths.push(candidate);
  }
  return paths;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
