---
"@bedrock-core/sync": minor
"@bedrock-core/server-runtime": minor
---

Rework the script-event wire format, and negotiate the protocol per peer instead of demanding a
match.

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

**`PROTOCOL_VERSION` is replaced by `PROTOCOL_MIN` and `PROTOCOL_MAX`.** A node advertises the
range it speaks in every announce and talks to each peer at the newest version both know, so a
world may hold addons built against different releases without partitioning. Gating on one exact
version would have made this bump — and every later one — a silent split: two meshes on a single
channel, each listing only its own half, each electing its own UI host, each timing out every RPC
to the other.

Consequently:

- A protocol-1 message is a bare frame with no tag, and is read as one. Announces and `whois` are
  pinned to `PROTOCOL_MIN` so the message that establishes a version never assumes one.
- Broadcasts go out at the lowest version any live peer can read, and packing stops while a peer
  that predates the batch tag is present. Both recover on their own once that peer expires.
- `PeerInfo` gains `protocol` and `caps`. Capabilities are advertised per node and narrowed by the
  negotiated version, so a later addition can appear or degrade without a version bump.
- A node whose range does not overlap this build's is reported through
  `Discovery.onIncompatible` / `Registry.onIncompatible` and listed by `Registry.incompatible()`,
  with a warning naming both ranges. It is named rather than silently absent.
- `negotiateProtocol` and `capsFor` are exported for anyone writing an interoperating
  implementation.

The support window is two versions wide. Raising `PROTOCOL_MIN` drops everything below it and is a
breaking change.

`MAX_MESSAGE`, the default per-message character budget, is now exported alongside the existing
`BusOptions.maxMessage` override.
