/**
 * The send/receive path, lifted out of `Bus` so it can run off-engine.
 *
 * `Bus` and `OutboundQueue` import `@minecraft/server` for the script-event channel and the tick
 * loops, but every byte-level decision — envelope encoding, tagging, packing, framing, reassembly —
 * lives in modules that import nothing. These helpers stitch those together in exactly the order
 * `Bus.send`, `OutboundQueue.takeNext` and `Bus.handleScriptEvent` do, so what is measured here is
 * what crosses the wire.
 */
import { Reassembler, splitIntoFrames } from '../src/chunk';
import { PROTOCOL_VERSION } from '../src/constants';
import { type Envelope, decodeEnvelope, encodeEnvelope } from '../src/envelope';
import { batchLength, decodeWire, encodeBatch, tagChunk } from '../src/wire';

/** A stable stand-in for a real node's instance id (`<tick36>-<8 random chars>`). */
export const INSTANCE_ID = 'ya-a1b2c3d4';

/** Message id in the shape `Bus.nextMid` produces: `<instanceId>/<counter>`. */
export const MESSAGE_ID = `${INSTANCE_ID}/1`;

/** Build the envelope `Bus.send` would build for a broadcast of `data`. */
export function envelopeFor(data: unknown, mid = MESSAGE_ID): Envelope {
  return {
    v: PROTOCOL_VERSION,
    src: 'benchmark',
    iid: INSTANCE_ID,
    type: 'state-delta',
    mid,
    data,
  };
}

/**
 * Send side for one envelope: whole if it fits under the cap, split into tagged frames if not.
 * Batching is deliberately excluded here — one envelope alone is the shape a latency-sensitive
 * message takes, and {@link packEnvelopes} covers the other case.
 */
export function toWire(envelope: Envelope, maxMessage: number): string[] {
  const encoded = encodeEnvelope(envelope);

  if (encoded.length + 1 <= maxMessage) { return [encodeBatch([encoded])]; }

  return splitIntoFrames(encoded, envelope.mid, maxMessage - 1).map(tagChunk);
}

/** Pack a run of envelopes into as few messages as the cap allows, the way the queue does. */
export function packEnvelopes(envelopes: readonly Envelope[], maxMessage: number): string[] {
  const messages: string[] = [];
  let parts: string[] = [];
  let lengths: number[] = [];

  for (const envelope of envelopes) {
    const encoded = encodeEnvelope(envelope);

    lengths.push(encoded.length);

    if (batchLength(lengths) > maxMessage && parts.length > 0) {
      messages.push(encodeBatch(parts));
      parts = [];
      lengths = [encoded.length];
    }

    parts.push(encoded);
  }

  if (parts.length > 0) { messages.push(encodeBatch(parts)); }

  return messages;
}

/**
 * Receive side: parse each message and either dispatch its envelopes or feed its frame to the
 * reassembler. `reassembler` is passed in so a benchmark can reuse one across iterations, the way
 * a live `Bus` does.
 */
export function fromWire(messages: readonly string[], reassembler: Reassembler, tick: number): Envelope[] {
  const received: Envelope[] = [];

  for (const message of messages) {
    const wire = decodeWire(message);

    if (!wire) { continue; }

    if (wire.kind === 'envelopes') {
      received.push(...wire.envelopes);
      continue;
    }

    const payload = reassembler.accept(wire.frame, tick);

    if (payload === undefined) { continue; }

    const envelope = decodeEnvelope(payload);

    if (envelope) { received.push(envelope); }
  }

  return received;
}

/** Total characters a group of messages puts on the bus. */
export function wireSize(messages: readonly string[]): number {
  let total = 0;

  for (const message of messages) { total += message.length; }

  return total;
}
