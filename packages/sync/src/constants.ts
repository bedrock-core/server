/** Protocol-wide constants shared by every layer. */

/** Bumped on any breaking change to the envelope or frame wire format. */
export const PROTOCOL_VERSION = 2;

/**
 * Leading character of a script-event message, saying which shape follows. See `wire.ts` for what
 * each one carries and why a one-piece message no longer travels inside a frame.
 */
export const WireTag = {

  /** The rest of the message is one JSON envelope. */
  Envelope: '0',

  /** The rest is one frame of an envelope too large to send whole. */
  Chunk: '1',

  /** The rest is a JSON array of envelopes packed into a single message. */
  Batch: '2',
} as const;

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
} as const;

export type MessageType = typeof MessageType[keyof typeof MessageType];
