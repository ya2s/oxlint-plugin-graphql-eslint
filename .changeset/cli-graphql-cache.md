---
"oxlint-plugin-graphql-eslint": patch
---

Load the schema and graphql-config `documents` (sibling operations) once per process in the one-shot CLI instead of reloading them every time graphql-eslint's 10-second cache expires mid-run. The language server (`oxlint --lsp`) keeps the 10-second reload so schema and operation edits still show up without a restart. Set `OXLINT_GRAPHQL_ESLINT_CACHE=ttl` or `persistent` to force either behaviour.
