# @bedrock-core/db

## 0.1.0

### Minor Changes

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - Add `@bedrock-core/db`: typed documents persisted on whatever dynamic properties a target can
  hold.
  
  **The host resolver** probes a target for where its documents can live — its own dynamic
  properties through the engine's six-method or component ABI, or a world property keyed by its
  identity when it holds nothing — behind one adapter over both ABIs, with a capability record per
  host, refusals by name for an `ItemStack` and a stackable slot, and a per-type cache that never
  caches a throw.
  
  **Collections** key documents by target on the host the resolver finds. One JSON envelope per
  document carries its version; migrations run lazily per document; `defaults` fill deep on read and
  a `normalize` runs on every write; `patch` merges plain objects recursively and replaces arrays and
  scalars, with `undefined` deleting a key. A document that cannot be read is quarantined under
  `<key>#bad` rather than deleted. A budget check runs before the engine, with chunking on the direct
  ABI, `accept` and `require` are checked at compile time against what the target type can do, and a
  validity gate re-resolves the target on every operation.
  
  **The chunked index** has a resumable `all()` that heals a replaced block, a `blockCleanup` custom
  component for `onBreak`, and `coalesce` write-behind that parks on `entityLoad` and flushes on
  `playerLeave` — wired to the engine only when a coalescing collection exists.
  
  A collection is **local**. Nothing here is reachable from another realm: what crosses is what the
  owning addon puts on one of the runtime's channels.
  
  Tuned for the engine throughout: hosts, resolutions, document stores and handles are classes with
  prototype methods, a handle resolves its target once per tick, the resolver trusts a cached type
  decision, index chunks are written behind, and a single value skips the batch write.

### Patch Changes

- Updated dependencies [[`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1)]:
  - @bedrock-core/observable@0.1.0
