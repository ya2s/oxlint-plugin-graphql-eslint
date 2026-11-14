---
"oxlint-plugin-graphql-eslint": patch
---

Diagnostics now keep the `messageId` (and `data`) graphql-eslint rules report with. oxlint resolves and interpolates them itself, so the rendered messages are unchanged, but oxlint's `RuleTester` can now assert on `messageId`/`data`. Also verified against oxlint 1.93.0.
