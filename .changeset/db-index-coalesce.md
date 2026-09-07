---
"@bedrock-core/db": minor
---

Add the chunked index with a resumable `all()` that heals a replaced block, the `blockCleanup`
custom component for `onBreak`, and `coalesce` write-behind with parking on `entityLoad` and a flush
on `playerLeave`, wired to the engine only when a coalescing collection exists.
