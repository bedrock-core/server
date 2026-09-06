# Spike S5 — dynamic-property ABI survey

**Measured 2026-09-05/06 on 1.26.50** with `probe-abi.ts` in `test-addon` (`/drav0011_economy:abi all`). One
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
| `ContainerSlot` holding a **non-stackable** item | direct | **sticks** | yes | yes | 32 767, throws | **327 µs** / 2 µs |
| `ContainerSlot` holding a **stackable** item (the mined probe block) | direct methods present | — | — | — | — | **write throws** `Cannot set dynamic properties on stackable items` — the live slot too, not only the copy |
| Block with `minecraft:block_entity` | component `get` / `set` / `totalByteCount` — reproduced here and in [S4](./S4-block-documents.md) | **sticks** | **no** | no | 900 chars ok, **throws at 1 000** | 11 µs / 1 µs |
| vanilla block (`minecraft:stone`) | **none** — no `minecraft:dynamic_properties` component | — | — | — | — | proxy required |

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

## Native DDUI observables (`@minecraft/server-ui` 2.1.0, `ObservableNumber`)

| Question | Answer |
| --- | --- |
| prototype members | `setData`, `getData`, `subscribe`, `unsubscribe` |
| `subscribe(cb)` returns | **the callback itself** — not an unsubscriber; calling it does nothing |
| how to stop listening | **`obs.unsubscribe(cb)`** → `boolean`; re-entrant (re-subscribe fires again, unsubscribe stops it) |
| `setData` with an equal value | **does not notify** — native guards equality itself |
| notification timing | **synchronous**, inside `setData`; nothing deferred to the next tick |
| cost | 1 000 × `setData` = 1 ms (**1 µs**); `getData` ≈ 0; 1 000 constructions = 3 ms |
| `toJSON` | absent — `JSON.stringify` gives `{}` |

Consequences for the [`toNative` bridge](../01-observable.md#native-observables--the-ddui-bridge):
`dispose()` must call `native.unsubscribe(cb)` with the exact callback it registered — nothing
else releases it; the `Object.is` guard on native → ours is still needed (native does not notify
on equal values, but *our* write into native must not echo back); a native observable is cheap
enough that one per visible control is free.

## Why the block half failed on the first pass

The block JSON declared a custom component (`drav0011_economy:s4_probe`) that no script registered
any more — the engine validates block components against the schema *including* script-registered
custom components at startup, and rejects the block outright: `this component was found in the
input, but is not present in the Schema`. Removing the reference fixed it. Rule for db's build step:
a `core:store_block`-style component the build injects must always be registered by the runtime, or
every accepted block type disappears from the world.

## The mined block-entity item (`place` → break → `item`)

| Question | Answer |
| --- | --- |
| `block_actor_dynamic_properties` on the drop | **present, empty** — `carried=undefined`, 0 bytes. The document does **not** travel into the drop by default; that is what the `carry_over_block_entity_data` loot function (1.26.40) exists for, and the probe block declared no loot table |
| write to the drop's `ItemStack` | throws — stackable |
| write to the **live `ContainerSlot`** holding it | **throws** — stackable. The slot ABI is not a host for stackable items at all |

Consequence: a `ContainerSlot` is a host only when its item is non-stackable (`maxAmount === 1`).
The static capability record for `ContainerSlot` is `own: boolean` — the instance decides, exactly
as a block's type does — and the resolver checks `slot.getItem()?.maxAmount === 1` before
offering the slot as a host. Carrying a block document into its drop is opt-in via the loot
function and stays outside the store until someone needs it.

**S5 is complete.** The probe (`probe-abi.ts`, `blocks/s4_probe.json`) is deleted.
