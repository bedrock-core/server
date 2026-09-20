# Spike S4 — block documents on native block dynamic properties

**Measured 2026-09-03 on the 1.26.50 preview**, custom block `drav0011_economy:s4_probe` with
`format_version` 1.26.50 and `minecraft:block_entity { dynamic_properties: true }`, no experiment
toggle. Probe: `packs/BP/scripts/probe-s4.ts` + `packs/BP/blocks/s4_probe.json` in `test-addon`
(deleted once this page was complete).

## Graduation

| Question | Answer |
| --- | --- |
| Works without the Upcoming Creator Features experiment? | **Yes.** `hasComponent('minecraft:dynamic_properties')` true, `get`/`set`/`totalByteCount` work |
| `format_version` | `1.26.50` accepted |
| Size cap | `totalByteCount` 937 at a 900-char value → **~1 024 bytes per pack per block including key and overhead** (37 bytes for key `doc` + empty value). 1 000 chars **throws** `Error: World metadata storage limit exceeded` — no truncation. Usable document ≈ 950 bytes |
| Survives world reload | **Yes** — doc read back identical after quit + reopen |

## Removal coverage — does the document die, does `onBreak` fire

| Means | Block after | Document | `onBreak` fired |
| --- | --- | --- | --- |
| `/setblock … air replace` (default mode) | air | gone | **yes** — docs say no; measured yes |
| `/setblock … air destroy` | air | gone | yes |
| `/fill … air` | air | gone | yes (once per block — 1 000 for the cube cleanup) |
| script `setPermutation(air)` | air | gone | **yes** — docs say no; measured yes |
| `createExplosion(r=2, breaksBlocks)` | air | gone | yes |
| player break (creative) | air | gone | yes |
| water source beside / above | unchanged | intact | — |
| piston push | **block does not move; piston does not extend** | intact | — (the later `setblock air` reset fired it) |
| re-place the same type after removal | new block | **fresh** (empty), not the old value | — |

Inside `onBreak`, `ev.block.typeId` is already `minecraft:air`, `Object.keys(ev)` is empty, and
the document reads `undefined` — **the document is not readable during `onBreak`**. An index
must key by location, never by document contents.

## Cost

| | Native block DP | World DP |
| --- | --- | --- |
| 2 000 × `set` (short string) | 22 ms → **11 µs** | 21 ms |
| 2 000 × `get` | 3 ms → **1.5 µs** | 2 ms |

Parity. 1 000 block entities placed with a document each: **49 ms** total; tick interval
49.98 → 49.99 ms (no measurable load; RAM not measurable from script — nothing visible in
the game at that count).

## Index

1 000 keys (`overworld:x,y,z`, 24 chars each): 23 999 chars in one DP — write 1 ms, parse 0 ms,
`getBlock` walk of all 1 000 (loaded) **8 ms**.

5 000 keys = 119 999 chars → `ArgumentOutOfBoundsError: String length … Argument max: 32767`.
**A dynamic property string caps at 32 767 characters and throws** — the S2 "failure mode"
question, answered by accident. The index chunks across DPs (≤ ~1 300 keys of this shape each);
re-measured in the `s2` step.

## Validity (S2.6)

| Question | Answer |
| --- | --- |
| `world.setDynamicProperty` inside `beforeEvents.playerLeave` | **Allowed**, and the value persisted across the session |
| `entityRemove` on chunk unload | **Fires** (armor stand, player walked away) — the event does not distinguish unload from death |
| `entityLoad` on return | fires, `isValid` true |
| `world.getEntity(id)` after reload for a loaded entity | returns the entity, `isValid` true |

## Consequences for [03-db](../03-db.md)

- Native backend is the default: graduation confirmed, orphan problem gone by construction.
- Document budget documented as **~950 bytes**; the store refuses larger with the collection named.
- `onBreak` covers every removal measured, including the two the docs exclude — the `worldKeyed`
  fallback's residue is smaller than written; keep validate-on-read anyway (undocumented ≠ guaranteed).
- Index: chunked DPs, keyed by location; `onBreak` cannot read the doc, so no per-document
  metadata in the index.
- Entity write-behind: parking on `entityRemove` is right — it fires for unload too, and the
  entity comes back through `entityLoad`.
- Player writes can flush in `beforeEvents.playerLeave` — the park step is unnecessary for players.
