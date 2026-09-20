# Spike S2 — world dynamic property costs

**Measured 2026-09-03 on the 1.26.50 preview**, same probe as [S4](./S4-block-documents.md)
(`s2` step), in a live world with the player nearby.

## Write and read cost

| Operation | Total | Per call |
| --- | --- | --- |
| 1 000 × `setDynamicProperty`, 1 KB string | 17 ms | **17 µs** |
| 100 × `setDynamicProperty`, 30 KB string | 19 ms | **190 µs** |
| 100 × `getDynamicProperty`, 30 KB string | 3 ms | **30 µs** |
| 2 000 × short-string `set` (from S4) | 21 ms | 11 µs |
| 2 000 × short-string `get` (from S4) | 2 ms | 1 µs |

Cost scales with payload, not with the number of properties: a 30 KB write is ~11× a 1 KB write.

## Write-behind vs write-through

1 000 logical writes to 50 distinct keys in one tick:

| Mode | Cost |
| --- | --- |
| write-through (1 000 DP writes) | 16 ms |
| write-behind (dirty map, 50 DP writes) | 4 ms |

Coalescing pays **4×** — but the write-through case is *1 000 writes in one tick*, a third of a
tick budget at an extreme rate. At 100 writes per tick it is 1.6 ms; at 10 it is noise.

## The cap

| Length | Result |
| --- | --- |
| 32 704 chars | ok, read back intact |
| 32 768 chars | `ArgumentOutOfBoundsError: … String length … Argument max: 32767` |
| 40 960 chars | same |

**A DP string holds at most 32 767 characters and the engine throws, never truncates.**

## Index at scale (from S4, chunked)

| Keys | Chunks | Chars | Write | Parse | `getBlock` walk |
| --- | --- | --- | --- | --- | --- |
| 1 000 | 1 | 23 999 | 0–1 ms | 0 ms | 8–9 ms (all loaded) |
| 5 000 | 4 | 119 996 | 0 ms | 2 ms | 50 ms (2 756 loaded; unloaded chunks return `undefined` fast) |

## Not measured

World-save impact at several MB of DPs (item 4). Nothing in the probe writes enough to see
it; left for a real addon to report.

## Decision — see [03-db](../03-db.md)

DP writes are cheap enough that **write-through is the default everywhere**; coalescing is a
per-collection opt-in for hot counters, not the store's reason to exist. The store is still a
subsystem — for block documents, validity, one `Location` seam and lazy per-document migrations —
not for batching.
