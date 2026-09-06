# Spike S7 — `@bedrock-core/observable` against the engine's `ObservableNumber`

**Measured 2026-09-06 in a realm on 1.26.50**, `probe-obs.ts` in `test-addon`, µs per operation,
same operation on both sides. Two runs: before and after switching listener storage to
copy-on-write (allocate on subscribe/unsubscribe, iterate a stable array on delivery).

| Operation | ours, before | ours, after | native | after ÷ native |
| --- | --- | --- | --- | --- |
| construct ×10 000 | 1.90 | **1.80** | 2.90 | 0.62× |
| `get` ×100 000 | 0.16 | **0.14** | 0.29 | 0.48× |
| `set`, 0 listeners ×100 000 | 1.59 | **0.43** | 0.41 | 1.05× |
| `set`, equal value ×100 000 | 0.24 | **0.24** | 0.41 | 0.59× |
| `set`, 1 listener ×100 000 | 1.79 | **0.54** | 0.87 | 0.62× |
| `set`, 10 listeners ×100 000 | 3.86 | **1.57** | 3.53 | 0.44× |
| subscribe + unsubscribe ×10 000 | 1.00 | **3.80** | 2.60 | 1.46× |
| derived chain (`computed` vs hand-wired `subscribe → setData`), set ×100 000 | 3.72 | **1.32** | 1.66 | 0.80× |
| `batch` of 100 000 sets | 0.30 / set, 1 notification | same | — | — |
| bridged set, ours → native ×100 000 | 2.61 | **1.33** | 0.41 (bare native set) | additive: our set + `getData` + `setData` |
| bridged pull, native → ours ×100 000 | 3.53 | **2.02** | — | additive |

## What it says

- **Before the change, every `set` paid ~1.2 µs to spread the listener set into an array**, even
  with no listeners. Copy-on-write removed it: parity with the engine on a bare set, ahead on
  everything that has listeners, and per-listener delivery at 0.11 µs against the engine's 0.31.
- **The trade is subscribe/unsubscribe** — an array copy each — 3.8 µs a pair. Those happen when a
  screen mounts or a form opens, not per tick.
- **`computed` beats a hand-wired native chain** (1.32 vs 1.66) because the intermediate native
  `setData` is the expensive step and ours is not.
- **The bridge adds nothing of its own**: a bridged set is exactly one of our sets plus one native
  `getData` + `setData`.
- **Absolute scale**: a pathological 10 000 sets in one tick costs 4 ms. Nothing here needs
  optimizing further; the point of the bar was "a plain object, not slower than the engine".

Probe deleted once this page was written.
