# oxlint-plugin-graphql-eslint

## 0.1.3

### Patch Changes

- 9e38a46: Load the schema and graphql-config `documents` (sibling operations) once per process in the one-shot CLI instead of reloading them every time graphql-eslint's 10-second cache expires mid-run. The language server (`oxlint --lsp`) keeps the 10-second reload so schema and operation edits still show up without a restart. Set `OXLINT_GRAPHQL_ESLINT_CACHE=ttl` or `persistent` to force either behaviour.
- ead155c: Expose `./package.json` from the package `exports` map so tooling that resolves `oxlint-plugin-graphql-eslint/package.json` (e.g. version checks) no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 0.1.2

### Patch Changes

- 97638e6: Memoize the graphql-config fingerprint per directory (1s TTL) instead of recomputing it on every
  `parseDocuments` call. Because each enabled rule parses a file separately, the fingerprint — a
  directory walk plus `existsSync`/`readFileSync`/`statSync` over the config and every schema path
  it names — was recomputed once per (rule × file). On a 300-file fixture with the 33-rule
  `operations-recommended` preset that was 9,900 calls costing 1,333ms, ~75% of the plugin's entire
  JS-side cost; the run drops from 2.10s to 0.89s with identical diagnostics. The TTL sits far below
  the ~10s floor `@graphql-eslint/eslint-plugin`'s own schema cache already imposes, so editor
  behaviour is unchanged.
- 447e9b6: Make the CI lint step an actual gate: `oxlint` reports at warning severity and exited `0` even
  when it found problems, so a lint regression could never fail the build.

## 0.1.1

### Patch Changes

- c5be005: Pin the CLI formatter in the end-to-end output test so it measures message text and positions
  rather than oxlint's environment detection, and add a changesets-driven release workflow that
  versions and publishes from `main` using npm trusted publishing (OIDC), so no npm token is
  stored in the repository.

## 0.1.0

### Minor Changes

- 87f74b7: Initial public release. Exposes all 64 `@graphql-eslint/eslint-plugin` rules, plus this
  package's own `graphql/parse-error`, as an oxlint JS plugin, with all five upstream flat configs
  ported (`schema-recommended`, `schema-all`, `schema-relay`, `operations-recommended`,
  `operations-all`), autofix/suggestion mapping onto host-file coordinates, and support for
  existing `graphql.config.*` files.
