import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerPath = fileURLToPath(new URL("./parse-staleness-runner.ts", import.meta.url));
const loaderPath = fileURLToPath(new URL("./strip-types-loader.mjs", import.meta.url));

export type StalenessResult = { first: string[]; second: string[] };

/**
 * Spawns tests/adapter/support/parse-staleness-runner.ts in a fresh `node` subprocess with
 * `NODE_ENV=production` pinned (see that file's doc comment for why this must be a subprocess,
 * not an in-process vitest call).
 *
 * `NODE` matters for a completely different, surprising reason from `NODE_ENV`: `pnpm run <script>`
 * (which is how this very test suite gets invoked by `pnpm test`) sets a bare `NODE` env var to
 * the node binary path, and inherits it down through vitest into whatever `execFileSync` spawns
 * from inside a test. `@graphql-eslint/eslint-plugin`'s schema cache (esm/cache.js's
 * `ModuleCache.get`) has `if (process.env.NODE || process.hrtime(lastSeen)[0] < settings.lifetime)
 * return result;` -- so when `NODE` is set to any truthy string, the cached schema would be
 * returned forever, WERE IT NOT for parse.ts's `parseForESLintWithCacheMode`, which deletes
 * `process.env.NODE` around each `parseForESLint` call in language-server mode.
 *
 * The runner is always passed `--lsp`, which is how parse.ts recognises the language server (see
 * `parseForESLintWithCacheMode`). Without it the subprocess would be in one-shot CLI mode, where
 * the schema is deliberately loaded once per process and the edit is never observed.
 *
 * By default (`nodeEnvValue` omitted) this deletes `NODE` from the spawned env entirely, so a
 * test's outcome reflects only `invalidateIfConfigChanged` (this package's own cache fix),
 * independent of whether the workaround above also happens to be doing its job. Pass
 * `nodeEnvValue` (e.g. the current `process.execPath`, mirroring what pnpm actually sets it to)
 * to force `NODE` to be set for the whole life of the subprocess -- i.e. to simulate a language
 * server launched via `pnpm exec`/`pnpm run` -- and specifically exercise the workaround.
 *
 * `waitMs` is the delay the runner waits, inside its single long-lived process, between editing
 * the schema file and calling `parseDocuments` a second time. Pass 0 to observe the state
 * immediately after the edit; pass something past `@graphql-eslint/eslint-plugin`'s own 10-second
 * schema-cache TTL to observe the state once that cache would have expired on its own.
 */
export function runParseStalenessScenario(input: {
  projectDir: string;
  schemaPath: string;
  waitMs: number;
  nodeEnvValue?: string;
}): StalenessResult {
  const { NODE: _unusedNode, ...restEnv } = process.env;
  const env: NodeJS.ProcessEnv = { ...restEnv, NODE_ENV: "production" };
  if (input.nodeEnvValue !== undefined) env.NODE = input.nodeEnvValue;

  const stdout = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--loader",
      pathToFileURL(loaderPath).href,
      runnerPath,
      input.projectDir,
      input.schemaPath,
      String(input.waitMs),
      "--lsp",
    ],
    { encoding: "utf8", env },
  );
  return JSON.parse(stdout) as StalenessResult;
}
