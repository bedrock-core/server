# @bedrock-core/observable

## 0.1.0

### Minor Changes

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - Add `@bedrock-core/observable`, the reactive primitive the stack notifies through: `observable`
  with `get` / `set` / `subscribe`, `computed`, `effect` and `batch`, delivering synchronously with
  listeners isolated from each other. `last(signal)` turns anything with `subscribe` — a Minecraft event
  signal included — into an observable of its most recent payload, `undefined` until the first one
  arrives, released with `dispose()`. The `/minecraft` entry bridges one of ours to a data-driven UI
  observable with `toNative`, keeping the native in step for a form's lifetime and writing back only
  when the control is client-writable.
