# Spike S5 — dynamic-property ABI survey

**Measured 2026-09-05** with `probe-abi.ts` in `test-addon` (`/drav0011_economy:abi all`). One
`describe()` per target: methods present, every `/ynamic/` member on the prototype chain, both
component ids, write-then-read on the same handle and on a **freshly fetched** handle,
enumeration, `Vector3`, `setDynamicProperties`, byte budget by ladder, 1 000× cost.

## The table the resolver is built from

| Target | ABI | Fresh-handle read | Enumerable | Batch | Cap | `set` / `get` |
| --- | --- | --- | --- | --- | --- | --- |
| `World` | direct | n/a (singleton) | yes | yes | 32 767 chars, throws | 10 µs / 1 µs |
| `Player` | direct | **sticks** | yes | yes | 32 767, throws | 10 µs / 2 µs |
| `Entity` (armor stand) | direct | **sticks** | yes | yes | 32 767, throws | 10 µs / 2 µs |
| `Dimension` | **none** — no method, no `getComponent` | — | — | — | — | proxy required |
| `ItemStack`, constructed `minecraft:stone` | direct methods present | — | — | — | — | **write throws** `UnsupportedFunctionalityError: Cannot set dynamic properties on stackable items` |
| `ItemStack` from `slot.getItem()` (non-stackable) | direct | **`undefined`** — the write landed on a copy | yes (on the copy) | yes | 32 767 | 12 µs / 2 µs |
| `ContainerSlot` (slot 0) | direct | **sticks** | yes | yes | 32 767, throws | **327 µs** / 2 µs |
| Block with `minecraft:block_entity` | component `get` / `set` / `totalByteCount` — from [S4](./S4-block-documents.md) | sticks | **no** | no | ~950 B, throws | 11 µs / 1.5 µs |
| vanilla block | not run this pass (block JSON rejected on this build); no `minecraft:dynamic_properties` component by construction | — | — | — | — | proxy required |

Every direct-ABI host exposes the same six methods — `getDynamicProperty`, `setDynamicProperty`,
`setDynamicProperties`, `getDynamicPropertyIds`, `getDynamicPropertyTotalByteCount`,
`clearDynamicProperties` — and nothing else matches `/ynamic/` on the prototype chain. No hidden
surface.

## What changed in the design

1. **`ItemStack` is refused twice over.** A *stackable* item throws on write; a *non-stackable*
   item accepts the write on a detached copy and the world never sees it — measured: same-handle
   read `probe`, fresh handle `undefined`. Structural typing alone would accept both. The resolver
   refuses `ItemStack` by name and points at `ContainerSlot`.
2. **A `ContainerSlot` write is 30× a world write** (327 µs vs 10 µs) — it goes through the item's
   NBT. Slot documents stay write-through (the slot can empty next tick) but the cost is documented
   and a slot collection is not the place for a per-tick counter.
3. **`minecraft:block_actor_dynamic_properties` exists on every block item**, stackable stone
   included — the *component* is there even when the item cannot hold data. Presence of the
   component is not sufficient; the resolver must confirm with a write, or prefer the direct ABI
   when both are present (it does: direct is checked first).
4. **`Dimension` is permanently proxied** — confirmed by absence: no method, no `getComponent`.
5. **Every direct host shares the 32 767-character cap and ~10 µs write**, so the capability
   record's `budget` is one constant for the direct family and ~950 bytes for the component family.

## Still open

- `/drav0011_economy:abi item` — the mined block-entity item: does `block_actor_dynamic_properties`
  carry the block's data into the stack (`carry_over_block_entity_data`), and can it be read back
  from a live slot? Needs the 1.26.50 build.
- Native DDUI observables — equal-value `setData` notification, `subscribe` return value,
  per-observable cost. Not in this probe yet.
- The probe left an armor stand at the player's position + 2 when it aborted; kill it by hand.
