import { parseForESLint } from "@graphql-eslint/eslint-plugin";
import { invalidateIfConfigChanged } from "./config-watch.js";
import { extractDocuments } from "./documents.js";
import { linkParents } from "./traverse.js";
import type { GqlNode, ParseError, ParsedDocument, ParserServices } from "./types.js";

const MAX_CACHE_ENTRIES = 8;

export const CACHE_MODE_ENV = "OXLINT_GRAPHQL_ESLINT_CACHE";

type CacheEntry = { code: string; schemaSdl: string | undefined; documents: ParsedDocument[] };

const cache = new Map<string, CacheEntry>();
let parseCallCount = 0;

export function clearParseCache(): void {
  cache.clear();
  parseCallCount = 0;
}

export function getParseCallCount(): number {
  return parseCallCount;
}

export function parseDocuments(options: {
  code: string;
  filePath: string;
  schemaSdl?: string;
}): ParsedDocument[] {
  // A long-lived process (the oxc language server) can outlive edits to graphql.config.* or the
  // schema files it points at. Neither is reflected in `code`/`schemaSdl`, the only inputs the
  // cache below is keyed on, so without this the cache would keep returning parses against a
  // schema that no longer matches disk. See config-watch.ts.
  invalidateIfConfigChanged(options.filePath, () => cache.clear());

  const cached = cache.get(options.filePath);
  if (cached && cached.code === options.code && cached.schemaSdl === options.schemaSdl) {
    cache.delete(options.filePath);
    cache.set(options.filePath, cached);
    return cached.documents;
  }

  const documents = extractDocuments(options.code, options.filePath).map((document) => {
    parseCallCount += 1;
    try {
      const parserOptions =
        options.schemaSdl === undefined
          ? { filePath: document.filePath }
          : { filePath: document.filePath, schemaSdl: options.schemaSdl };
      const result = parseForESLintWithCacheMode(document.text, parserOptions) as unknown as {
        ast: GqlNode;
        services: ParserServices;
      };
      // Parent the whole AST once, here, before it is ever handed to a rule. See
      // linkParents' own doc comment in traverse.ts for why this must happen at parse time
      // rather than inside traverse() itself.
      linkParents(result.ast);
      return { kind: "parsed", document, ast: result.ast, services: result.services } as const;
    } catch (error) {
      return { kind: "error", document, error: toParseError(error) } as const;
    }
  });

  cache.set(options.filePath, { code: options.code, schemaSdl: options.schemaSdl, documents });
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return documents;
}

/**
 * Chooses how long `@graphql-eslint/eslint-plugin@4.4.1` keeps the schema and sibling operations
 * it loads from graphql-config. Both go through `esm/cache.js`'s `ModuleCache.get`:
 *
 *   if (process.env.NODE || process.hrtime(lastSeen)[0] < settings.lifetime) return result;
 *
 * Each entry expires 10 seconds after it was loaded, unless `process.env.NODE` (almost certainly
 * an upstream typo for `NODE_ENV`) is set to any truthy string, in which case it never expires.
 * `pnpm run <script>`/`pnpm exec` always set `NODE`, so the outcome would otherwise depend on how
 * oxlint happened to be launched. Instead it is pinned per mode:
 *
 * - `persistent` (the one-shot CLI): `NODE` is forced truthy, so the schema and the whole
 *   `documents` glob are loaded once per process. Re-loading them every 10 seconds bought
 *   nothing in a run that never sees an edit, and on a large project each reload of the
 *   operations alone took seconds.
 * - `ttl` (the language server, `oxlint --lsp`): `NODE` is deleted, so the 10-second expiry is
 *   what lets schema and sibling-operation edits reach a long-lived process. See
 *   config-watch.ts's doc comment.
 *
 * The plugin cannot own this invalidation itself: `ModuleCache` is module-private upstream, and
 * config-watch.ts's fingerprint covers the config and schema files but not the `documents`
 * glob, so it could not tell when siblings need reloading.
 *
 * The mode comes from `process.argv`: JS plugins run in the same Node process as the `oxlint`
 * bin, which itself switches on `args.includes("--lsp")` (oxlint/dist/cli.js). `CACHE_MODE_ENV`
 * overrides it for launchers that don't pass `--lsp` through.
 *
 * `parseForESLint` is synchronous, so swapping `process.env.NODE` around just this call cannot be
 * observed by anything else, and `finally` restores it even if the call throws. Delete this once
 * upstream stops checking `process.env.NODE` (persistent mode would then need another route).
 */
function parseForESLintWithCacheMode(
  ...args: Parameters<typeof parseForESLint>
): ReturnType<typeof parseForESLint> {
  const persistent = cacheMode() === "persistent";
  const hadNode = Object.hasOwn(process.env, "NODE");
  const savedNode = process.env.NODE;
  if (persistent) {
    if (!savedNode) process.env.NODE = process.execPath;
  } else {
    delete process.env.NODE;
  }
  try {
    return parseForESLint(...args);
  } finally {
    if (hadNode) process.env.NODE = savedNode;
    else delete process.env.NODE;
  }
}

function cacheMode(): "persistent" | "ttl" {
  const override = process.env[CACHE_MODE_ENV];
  if (override === "persistent" || override === "ttl") return override;
  if (override) {
    throw new Error(`${CACHE_MODE_ENV} must be "persistent" or "ttl", got ${JSON.stringify(override)}`);
  }
  return process.argv.includes("--lsp") ? "ttl" : "persistent";
}

function toParseError(error: unknown): ParseError {
  const raw = error as { message?: string; lineNumber?: number; column?: number };
  // Only GraphQL syntax errors carry a `lineNumber` (see @graphql-eslint/eslint-plugin's
  // parser.js, which attaches it only for `GraphQLError` instances). Config/schema loading
  // failures do not, so re-throw those instead of masking them as a per-document parse error.
  if (typeof raw?.message !== "string" || typeof raw.lineNumber !== "number") throw error;
  return {
    message: raw.message,
    line: raw.lineNumber,
    column: raw.column ?? 0,
  };
}
