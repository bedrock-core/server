# Spike S6 — what a shared delta costs on the bus

**Measured 2026-09-08 on BDS 1.26.43.1**, headless through `bc-bds run --tag bench`. Probe:
`packs/BP/scripts/tests/bench-shared.ts` in `test-addon`, kept rather than deleted — it is a
benchmark under the `bench` tag, not a throwaway, and `scripts/bench-report.mjs` reads its
`BENCH {...}` lines out of the transcript.

Peers are separate `State` instances over their own `Bus`, all in one script realm, talking through
the engine's real `scriptEvent` transport. Broadcasts go over the wire: the loopback shortcut in
`Bus.send` applies only to a message addressed to the sender's own id.

## Numbers

Publishing, over 50 runs so the figure is not `Date.now()` noise:

| Value | µs per `state.set()` | Share of one 50 ms tick |
| --- | --- | --- |
| 1 KB | 380 | 0.8 % |
| 10 KB | 3 120 | 6.2 % |

Convergence, worst peer of each fan-out:

| Peers | Value | Ticks to converge | Arrived |
| --- | --- | --- | --- |
| 2 | 1 KB | 0 | 2 of 2 |
| 4 | 1 KB | 0 | 4 of 4 |
| 2 | 10 KB | 0 | 2 of 2 |
| 4 | 10 KB | 0 | 4 of 4 |

Boot burst — 100 keys of 200 B published in one tick, as a `persisted` shared tree does a tick
after registration:

| Keys | Applied | Ticks | ms | Snapshot entries a late joiner replays |
| --- | --- | --- | --- | --- |
| 100 | 100 | 1 | 119 | 100 |

## What the numbers say

**Publishing is the cost, not delivery.** A 10 KB value costs the owner 3.1 ms on its own tick, 8×
a 1 KB one and 6 % of a tick for a single key. The work is serialization and it lands on the caller
synchronously, so an addon that republishes a large tree every tick will show up as a tick-time
regression in its own realm before anything is visible on the wire.

**Fan-out is free to the owner.** One broadcast reaches every peer, so 2 and 4 peers cost the
publisher the same. Apply cost is per-peer and does scale, but it is paid in each peer's own realm.

**A delta converges in the same tick it is sent**, at both sizes and both fan-outs. The established
`send_latency` benchmark reports the same 0 ticks for raw envelopes, so this is the transport's
behaviour rather than an artifact of this probe.

**The boot burst survives.** All 100 keys applied, one tick later, nothing dropped.

## What this gates

**The `shared` cap on db collections is viable, with a size caveat.** Delivery is same-tick and
lossless at 4 peers, so a shared collection's readers are not waiting on the transport. The limit
is document size on the publishing side: at 10 KB a single publish is already 6 % of a tick, so a
`shared` collection wants either small documents or a coalesced publish, not a write-through one
per mutation.

**Phase 6's warm read from the mirror holds.** A peer's copy is present on the tick after the
owner writes, so a query reading the mirror is reading something current rather than something it
has to justify.

## Caveats

`Date.now()` in the engine has millisecond resolution, so the per-delta `ms` figures are noise —
one 1 KB delta reported 66 ms and one 10 KB delta 12 ms in the same run, ordering artifacts rather
than a real difference. Only the 50-run publish figures and the tick counts are load-bearing here.

Peers share this realm's QuickJS heap. Four separate packs would each parse their own copy of a
value, and that parse is counted once here. Apply and convergence hold; per-realm memory is
unmeasured.
