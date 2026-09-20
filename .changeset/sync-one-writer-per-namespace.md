---
"@bedrock-core/sync": minor
"@bedrock-core/server-runtime": minor
---

**Breaking.** A node writes one namespace, the one named by its id. `ownedNamespaces` and `strictOwnership` are removed from `createSync` / `SyncNode`, and `StateOptions` from the exports: every mirror only ever applied a namespace's writes from the node whose id it is, so the options could not widen that. A write to another node's namespace is dropped by every mirror and counted in `droppedForeign`, and a node answers snapshot requests for its own namespace.
