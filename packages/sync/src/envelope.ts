/**
 * The logical message exchanged between addons. Envelopes are JSON-serialized and then, depending
 * on the protocol the sender picked for the recipient, sent whole behind a wire tag or nested in
 * one or more {@link Frame}s by the chunker before they hit the bus.
 */
import { PROTOCOL_MAX, PROTOCOL_MIN } from './constants';

/** One message between nodes: who sent it, what it is, and its data. */
export interface Envelope<T = unknown> {

  /**
   * Protocol version this envelope was written at — somewhere in
   * [{@link PROTOCOL_MIN}, {@link PROTOCOL_MAX}]. The sender picks it per recipient, so the same
   * node emits different versions to different peers.
   */
  v: number;

  /** Sender addon id. */
  src: string;

  /**
   * Sender instance id — unique per node even when two nodes share the same `src` (a
   * namespace collision). Used to drop a node's own echoes and to detect collisions.
   */
  iid: string;

  /** Target addon id; omitted for a broadcast. */
  dst?: string;

  /** Message type (see `MessageType`). */
  type: string;

  /** Per-message id, used for RPC correlation and as the chunk-group id. */
  mid: string;

  /** Type-specific payload. */
  data?: T;
}

/** Serialize an envelope to its wire string. */
export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

/**
 * Structural check for a parsed envelope, including that its protocol version falls inside the
 * window this build supports. Exported because a batched message arrives as an array of
 * already-parsed objects rather than as JSON text.
 *
 * The check is a range rather than an equality: a peer one version behind is understood, not
 * ignored. Only a version outside the window — too old to still be supported, or newer than
 * anything this build knows — is refused.
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) { return false; }

  if (!('v' in value && 'src' in value && 'iid' in value && 'type' in value && 'mid' in value)) { return false; }

  const { v, src, iid, type, mid } = value;
  const dst = 'dst' in value ? value.dst : undefined;

  return (
    typeof v === 'number'
    && v >= PROTOCOL_MIN
    && v <= PROTOCOL_MAX
    && typeof src === 'string'
    && typeof iid === 'string'
    && typeof type === 'string'
    && typeof mid === 'string'
    && (dst === undefined || typeof dst === 'string')
  );
}

/**
 * Parse an envelope from its wire string. Returns `undefined` for malformed JSON, a structurally
 * invalid envelope, or a protocol version outside the supported window — callers ignore those
 * rather than throwing, so one bad sender can never crash a listener.
 */
export function decodeEnvelope(json: string): Envelope | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  return isEnvelope(parsed) ? parsed : undefined;
}
