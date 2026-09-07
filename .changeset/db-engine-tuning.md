---
"@bedrock-core/db": patch
---

Tune for the engine: hosts, resolutions, document stores and handles are classes with prototype
methods; a handle resolves its target once per tick; the resolver trusts a cached type decision;
index chunks are written behind; a single value skips the batch write.
