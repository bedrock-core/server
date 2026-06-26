/**
 * The logical message exchanged between addons. Envelopes are JSON-serialized and then
 * split into one or more wire {@link Frame}s by the chunker before they hit the bus.
 */
import { PROTOCOL_VERSION } from './constants';

export interface Envelope<T = unknown> {

  /** Protocol version (see {@link PROTOCOL_VERSION}). */
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
 * Parse an envelope from its wire string. Returns `undefined` for malformed JSON, a
 * structurally invalid envelope, or a mismatched protocol version — callers ignore those
 * rather than throwing, so one bad sender can never crash a listener.
 */
function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) { return false; }

  if (!('v' in value && 'src' in value && 'iid' in value && 'type' in value && 'mid' in value)) { return false; }

  const { v, src, iid, type, mid } = value;
  const dst = 'dst' in value ? value.dst : undefined;

  return (
    v === PROTOCOL_VERSION
    && typeof src === 'string'
    && typeof iid === 'string'
    && typeof type === 'string'
    && typeof mid === 'string'
    && (dst === undefined || typeof dst === 'string')
  );
}

export function decodeEnvelope(json: string): Envelope | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  return isEnvelope(parsed) ? parsed : undefined;
}
