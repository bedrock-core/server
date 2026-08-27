/**
 * The wire layer: what one script-event message actually contains.
 *
 * An {@link Envelope} used to be nested inside a {@link Frame}'s `p` field even when it fitted in a
 * single message, which meant JSON-escaping the whole thing to sit inside a JSON string — every
 * quote paid for a backslash, and a one-piece message still carried a header describing a split
 * that never happened. Most bus traffic is one-piece (heartbeats, state deltas, RPC calls), so that
 * was the common case paying for the rare one.
 *
 * A message now opens with a tag character saying which of three shapes follows:
 *
 * ```text
 * 0{"v":2,"src":"shop",…}          one envelope, verbatim — nothing is nested, nothing is escaped
 * 2[{"v":2,…},{"v":2,…}]           several envelopes packed into one message
 * 1{"c":"…","s":0,"t":9,"p":"…"}   one frame of an envelope too large to send whole
 * ```
 *
 * Batching is what keeps the tag from being a rounding error: the engine takes a bounded number of
 * script events per tick, not a bounded number of bytes, so a 100-character heartbeat sent alone
 * spends a whole slot. Packing consecutive small messages trades unused bytes for slots.
 *
 * A node speaking the previous protocol emits messages starting with `{`, which matches no tag and
 * is discarded by {@link decodeWire} — a version mismatch goes quiet rather than wrong.
 */
import { type Frame, decodeFrame } from './chunk';
import { WireTag } from './constants';
import { type Envelope, isEnvelope } from './envelope';

/** One decoded script-event message: either envelopes to dispatch, or a frame to reassemble. */
export type WireMessage
  = { kind: 'envelopes'; envelopes: Envelope[] }
    | { kind: 'chunk'; frame: Frame };

/**
 * Pack already-encoded envelopes into one message. The parts are spliced as text rather than
 * re-serialized, since the queue holds them encoded precisely so it can measure them.
 */
export function encodeBatch(encodedEnvelopes: readonly string[]): string {
  if (encodedEnvelopes.length === 1) { return WireTag.Envelope + encodedEnvelopes[0]; }

  return `${WireTag.Batch}[${encodedEnvelopes.join(',')}]`;
}

/**
 * Length of the message {@link encodeBatch} would produce: the tag, the brackets, the parts and the
 * commas between them. Used by the queue to decide what still fits.
 */
export function batchLength(partLengths: readonly number[]): number {
  if (partLengths.length === 0) { return 0; }

  let total = 0;

  for (const length of partLengths) { total += length; }

  // One envelope needs no brackets: tag + part. Otherwise tag + '[' + parts + separators + ']'.
  return partLengths.length === 1 ? total + 1 : total + partLengths.length + 2;
}

/** Tag an already-encoded frame as the chunk it is. */
export function tagChunk(encodedFrame: string): string {
  return WireTag.Chunk + encodedFrame;
}

/**
 * Parse a script-event message. Returns `undefined` for an unknown tag, malformed JSON or a
 * structurally invalid body — callers ignore those rather than throwing, so one bad sender can
 * never crash a listener. A batch keeps whichever of its envelopes are valid.
 */
export function decodeWire(message: string): WireMessage | undefined {
  const body = message.slice(1);

  switch (message[0]) {
    case WireTag.Envelope: {
      const envelope = parseJson(body);

      return isEnvelope(envelope) ? { kind: 'envelopes', envelopes: [envelope] } : undefined;
    }

    case WireTag.Batch: {
      const parsed = parseJson(body);

      if (!Array.isArray(parsed)) { return undefined; }

      const envelopes = parsed.filter(isEnvelope);

      return envelopes.length > 0 ? { kind: 'envelopes', envelopes } : undefined;
    }

    case WireTag.Chunk: {
      const frame = decodeFrame(body);

      return frame ? { kind: 'chunk', frame } : undefined;
    }

    default:
      return undefined;
  }
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
