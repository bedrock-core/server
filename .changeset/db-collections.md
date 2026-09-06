---
"@bedrock-core/db": minor
---

Add collections: typed documents keyed by target on whatever host the resolver finds. One JSON
envelope per document carrying its version, lazy per-document migrations with `defaults` applied
on read, quarantine under `<key>#bad` instead of deletion, a budget check before the engine with
chunking on the direct ABI, `accept` and `require` with a compile-time check against what the
target type can do, and a validity gate that re-resolves the target on every operation.
