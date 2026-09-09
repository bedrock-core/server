/** Protocol-wide constants shared by every layer. */

/**
 * Protocol support window.
 *
 * A node advertises the range it can speak and talks to each peer at the highest version they
 * both support, so a world may hold addons built years apart without partitioning. Gating on a
 * single version instead would make every bump a silent split: two meshes on one channel, each
 * listing only its own half.
 *
 * `PROTOCOL_MIN` is the oldest wire format this build still reads and writes; `PROTOCOL_MAX` the
 * newest it knows. Raising `MIN` drops support for everything below it, which is a breaking
 * change — the window is two versions wide, so a version is readable for two releases after it
 * stops being written.
 */
export const PROTOCOL_MIN = 1;

/** Newest protocol this build speaks. See {@link PROTOCOL_MIN}. */
export const PROTOCOL_MAX = 2;

/**
 * First protocol that reads the wire tag. Below it a message must be a bare frame, which is why
 * this is the line {@link encodeLegacy} is chosen on rather than a bare `2` in the bus.
 */
export const TAGGED_WIRE_PROTOCOL = 2;

/**
 * Optional behaviours a node advertises alongside its protocol range.
 *
 * A capability is what a peer can *read*, so a sender consults the receiver's set before using
 * one. Versions move in lockstep for everyone; capabilities let a single behaviour appear,
 * degrade, or disappear on its own, which is what keeps the next addition from needing a bump.
 */
export const Cap = {

  /** Reads a {@link WireTag.Batch} message: several envelopes packed into one. */
  Batch: 'batch',
} as const;

/** A capability a node can advertise. */
export type Cap = typeof Cap[keyof typeof Cap];

/** Everything this build can read. Broadcast in every announce. */
export const SELF_CAPS: readonly Cap[] = [Cap.Batch];

/**
 * Leading character of a script-event message, saying which shape follows. See `wire.ts` for what
 * each one carries; a one-piece message travels verbatim.
 *
 * The tag is frozen: a shape added later takes a new character, and a reader that does not know a
 * character drops that one message rather than the peer that sent it. Protocol 1 predates the tag
 * and opens with `{`, which `decodeWire` recognises as the bare frame it is.
 */
export const WireTag = {

  /** The rest of the message is one JSON envelope. */
  Envelope: '0',

  /** The rest is one frame of an envelope too large to send whole. */
  Chunk: '1',

  /** The rest is a JSON array of envelopes packed into a single message. */
  Batch: '2',
} as const;

/** The leading character of a message. */
export type WireTag = typeof WireTag[keyof typeof WireTag];

/** The single script-event namespace all bedrock-core traffic flows through. */
export const BUS_NAMESPACE = 'bedrock-core';

/** The single script-event channel id (`namespace:path`). */
export const BUS_CHANNEL = `${BUS_NAMESPACE}:bus`;

/**
 * Conservative upper bound (in characters) for one outbound script-event message. Set well
 * below the engine's real cap; the chunker keeps every frame under this.
 */
export const MAX_MESSAGE = 2000;

/** Max messages flushed from the outbound queue per tick, to respect the engine's cap. */
export const MAX_FLUSH_PER_TICK = 50;

/** How often (in ticks) the outbound queue flushes. */
export const FLUSH_INTERVAL_TICKS = 1;

/** Ticks an incomplete chunk group is retained before being discarded. */
export const CHUNK_TTL_TICKS = 200;

/** Default ticks before an RPC request rejects with a timeout (5s at 20 tps). */
export const DEFAULT_RPC_TIMEOUT_TICKS = 100;

/** How often (in ticks) each node re-announces its presence (heartbeat). */
export const ANNOUNCE_INTERVAL_TICKS = 100;

/** Ticks without hearing from a peer before it is considered gone. */
export const PEER_TTL_TICKS = 320;

/** Envelope message types. */
export const MessageType = {
  /** Presence broadcast / heartbeat. */
  Announce: 'announce',

  /** "Who is here?" — prompts every peer to re-announce to the requester. */
  Whois: 'whois',

  /** RPC request. */
  Request: 'req',

  /** RPC response. */
  Response: 'res',

  /** A single key write in the replicated state. */
  StateDelta: 'state-delta',

  /** "Send me your state" — prompts namespace owners to reply with a snapshot. */
  StateRequest: 'state-req',

  /** A full namespace dump used to (re)build a mirror. */
  StateSnapshot: 'state-snapshot',

  /** A happening the sender announces to every realm; delivered once, kept by nobody. */
  Event: 'event',
} as const;

/** What an envelope carries, by name. */
export type MessageType = typeof MessageType[keyof typeof MessageType];
