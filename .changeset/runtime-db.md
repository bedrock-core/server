---
"@bedrock-core/server-runtime": minor
---

Add `core.db`, this addon's `@bedrock-core/db` keyed under its namespace, and re-export the
declaration API (`schema`, the acceptors and combinators, the errors) so an addon declares a
collection from the runtime import alone.
