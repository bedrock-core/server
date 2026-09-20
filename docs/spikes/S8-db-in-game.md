# Spike S8 — `@bedrock-core/db` in the engine

**Measured 2026-09-07 on the 1.26.50 preview**, `@minecraft/server` 2.10.0, custom block
`drav0011_economy:db_probe` with `minecraft:block_entity { dynamic_properties: true }` and the
`blockCleanup` component. Probe: `packs/BP/scripts/probe-db.ts` + `packs/BP/blocks/db_probe.json`
in `test-addon`, driven by `/drav0011_economy:db all` (deleted once this page was complete).
Timings are `Date.now()` deltas over 1 000 operations, so ±1 ms.

## What works

| Check | Result |
| --- | --- |
| 1 000 block-entity documents written through `probes.for(block).set()` | all on the block's own properties (`where` → `own: true, budget 950`), nothing but the index on the world |
| `probes.all()` over 1 000 index entries | 1 000 handles, all available, all with a document |
| `blockCleanup` on `setBlockType(stone)`, `setBlockType(air)`, `/setblock … replace`, `/fill … air` | `onBreak` fires for each, **one tick later** — the index shows the drop on the next tick, never in the same call |
| a stone block at a former document's position | `where` → `minecraft:stone is not accepted`, `get` → `undefined`; the old document died with the block entity |
| 1 000 coalesced `patch` on the player, then one flush | the property holds the last value; nothing written before the flush |
| the index after `/fill` over the cube | 0 entries, chunk properties emptied |

## Cost, and what it took

Bedrock's script engine is QuickJS: closures and native property lookups dominate, not the
dynamic-property write. Four rounds:

| 1 000× | round 1 | index write-behind, per-tick memo, single-value writes | classes, cached type decisions | raw engine |
| --- | --- | --- | --- | --- |
| new block document incl. index | 370 ms | 166 ms | **91 ms** | getBlock 3 + getComponent 5 + component.set 14 |
| walk 1 000 index entries (`all()` + `available` + `get`) | 178 ms | 88 ms | **56 ms** | getBlock 3 + getComponent 5 + component.get 3 |
| `resolver.resolve(player)` | — | 15 ms | **5 ms** | id + typeId reads 0 |
| `resolver.resolve(block)` | — | 34 ms | **21 ms** | getComponent 5 |
| `for(player)` with no operation | — | 37 ms | **10 ms** | — |
| `for(player).get()` | 52 ms | 34 ms | **14 ms** | getDynamicProperty 2 + JSON.parse 2 |
| write-through `patch` on one handle | 83 ms | 26 ms | **28 ms** | setDynamicProperty 12 |
| write-through `patch` via `for(player)` each time | 122 ms | 95 ms | **46 ms** | setDynamicProperty 12 |
| cached `get()` on one handle | 18 ms | 1 ms | **1 ms** | — |
| `available` | 18 ms | 1 ms | **1 ms** | — |
| coalesced `patch` | 24 ms | 6 ms | **6 ms** | — |

What each round removed:

1. **Index write-behind.** Every add rewrote its whole chunk string (up to 32 767 characters); a
   thousand placements meant a thousand growing rewrites. Now a change marks the chunk dirty and
   `system.run` writes each dirty chunk once. The index lives on the world, which cannot vanish,
   so nothing is at risk.
2. **Per-tick memo.** A handle re-resolved its target on every operation — `getEntity`/`getBlock`,
   `getComponent`, a new resolution and store. Within one tick the script is the only actor, so a
   handle now resolves once per `system.currentTick`; an engine throw on a target the script itself
   removed becomes `DbTargetError`.
3. **Single-value writes** go through `setDynamicProperty`; the batch call is for chunk sets only.
4. **Classes, not closures.** Host, prefixed host, resolution, document store and handle were
   closure bundles made per operation (~30 closures per `for()`). They are classes with prototype
   methods now, and the resolver trusts a cached type decision instead of probing four methods on
   the target again — a block entity skips the direct-ABI probe entirely.

## What the numbers mean for the design

- **Write-through `patch` costs ~2.3× a raw property write** (28 vs 12 µs): JSON, a merge, a
  chunk-count read, the cache and the change event. Acceptable for documents; not for a per-tick
  counter — that is what `coalesce` is for, at **6 µs a patch**, 4.7× cheaper.
- **`for()` is 10 µs on an entity and 30 on a block.** Hold the handle when hammering one target;
  the per-tick memo makes a held handle nearly free.
- **A block document is ~90 µs to create, ~55 µs to visit through `all()`.** 1 000 elevators walked
  in 56 ms means 20 per tick is 1.1 ms — the example's pacing.
- **The index costs ~65 bytes per block** (`block:minecraft:overworld:1625,-60,1075:drav0011_economy:db_probe`);
  1 000 blocks = 69 KB in three chunks. Fine for thousands, not for hundreds of thousands. A denser
  encoding is a later step if a collection ever needs it.
- **`onBreak` is deferred by a tick.** Code that removes a block and reads the index in the same
  call sees the old entry; `all()` heals it anyway.

## Left unmeasured

- `coalesce` parking across a chunk unload and `entityLoad` — needs a world where the entity's
  chunk actually unloads; covered by unit tests against the measured event semantics (S4).
- The `beforeEvents.playerLeave` flush — S4 measured the write is allowed there; not re-measured.
