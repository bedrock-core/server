# @bedrock-core/observable

## 1.0.0

### Major Changes

- [`dbd986e`](https://github.com/bedrock-core/server/commit/dbd986eab69a2eddfbb926c781adacf2df6db0cd) Thanks [@drav0011](https://github.com/drav0011)! - Release the observable and synchronization packages as stable 1.0 APIs. Their public exports follow semantic versioning independently of the server runtime.

### Minor Changes

- [`7aec84d`](https://github.com/bedrock-core/server/commit/7aec84d48f48b2758cdc55d470d765de262fe9db) Thanks [@drav0011](https://github.com/drav0011)! - Add `debounce(source, schedule, options?)` for read-only values that publish the latest source change after a quiet period, with cancellation and disposal. Add `afterTicks(ticks)` to the `/minecraft` entry for reusable Minecraft tick scheduling, and declare `@minecraft/server` as an optional peer dependency. Both helpers are re-exported through `@bedrock-core/server/observable`.

## 0.1.0

### Minor Changes

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - Add `@bedrock-core/observable`, the reactive primitive the stack notifies through: `observable`
  with `get` / `set` / `subscribe`, `computed`, `effect` and `batch`, delivering synchronously with
  listeners isolated from each other. `last(signal)` turns anything with `subscribe` — a Minecraft event
  signal included — into an observable of its most recent payload, `undefined` until the first one
  arrives, released with `dispose()`. The `/minecraft` entry bridges one of ours to a data-driven UI
  observable with `toNative`, keeping the native in step for a form's lifetime and writing back only
  when the control is client-writable.
