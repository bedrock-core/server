---
"@bedrock-core/sync": minor
---

Rework the script-event wire format. `PROTOCOL_VERSION` is now `2`; nodes on either version ignore
the other's traffic rather than misreading it.

A message now opens with a tag saying which shape follows: one envelope, a batch of envelopes, or
one frame of a chunked envelope. An envelope that fits in a message is sent whole instead of nested
inside a frame's `p` field, so it is no longer JSON-escaped to sit inside a JSON string — a small
message loses about a third of its length, and a round trip costs roughly half the CPU.

The outbound queue packs consecutive envelopes into one message up to the size cap. The engine
bounds script events per tick by count rather than by size, so a node that sends a burst in a single
tick — a run of `State.set` calls, a snapshot broadcast, an RPC fan-out — now spends a few of its
per-tick slots instead of one per envelope. Each addon has its own queue, so this packs one node's
own traffic and never several nodes' together.

Framing charges each character what JSON actually spends escaping it, rather than reserving two
characters for every one. Real payloads fill a frame instead of half of it: a 16KB envelope splits
into 10 frames where it previously took 18.

`MAX_MESSAGE`, the default per-message character budget, is now exported alongside the existing
`BusOptions.maxMessage` override.
