/**
 * The wire layer: what one script-event message actually contains.
 *
 * A message opens with a tag character saying which of three shapes follows:
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
 * ## Reading protocol 1
 *
 * Protocol 1 predates the tag: every message was a bare {@link Frame}, so it opens with `{`. The
 * frame shape never changed, only what wraps it, so such a message decodes through the same
 * reassembly path once recognised — which is the whole of what {@link decodeWire} needs to
 * understand a node built against an older release. {@link encodeLegacy} produces that shape for
 * peers that can only read it.
 *
 * A shape added in some later protocol takes a tag character of its own; a reader that does not
 * know the character drops that one message rather than the peer that sent it.
 */
import { type Frame, decodeFrame, splitIntoFrames } from './chunk';
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
 * Encode an envelope the way protocol 1 did: bare frames, no tag, the envelope nested in `p` even
 * when it fits in one message. Each returned string is a finished message that must be sent on its
 * own — there is no shape a protocol-1 reader would accept two envelopes in.
 *
 * Every supported protocol can read this, which is what makes it the form used for announces and
 * for any broadcast heard by a peer that cannot read the tag.
 */
export function encodeLegacy(encodedEnvelope: string, mid: string, maxMessage: number): string[] {
  return splitIntoFrames(encodedEnvelope, mid, maxMessage);
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

    // A protocol-1 message is a bare frame, so it opens with the JSON it is rather than with a
    // tag. The whole message is the frame — nothing was sliced off the front of it.
    case '{': {
      const frame = decodeFrame(message);

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
