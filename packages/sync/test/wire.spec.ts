/**
 * Wire-shape invariants.
 *
 * Two things here are load-bearing beyond their size. `batchLength` must agree with `encodeBatch`
 * exactly, because the queue decides what still fits by asking the former and then sends the
 * latter — a disagreement of one character is a message over the engine's cap, dropped at send
 * time with nothing but a counter to show for it. And `decodeWire` has to place every shape the
 * supported window still contains — the same channel carries traffic from nodes built against
 * older releases, and a shape it fails to place is an addon that silently drops out of the world.
 */
import { describe, expect, it } from 'vitest';
import { Reassembler, encodeFrame } from '../src/chunk';
import { PROTOCOL_MAX, PROTOCOL_MIN, WireTag } from '../src/constants';
import { type Envelope, decodeEnvelope, encodeEnvelope } from '../src/envelope';
import { batchLength, decodeWire, encodeBatch, encodeLegacy, tagChunk } from '../src/wire';

function envelope(mid: string, data: unknown = 'x'): Envelope {
  return { v: PROTOCOL_MAX, src: 'test', iid: 'iid-1', type: 'state-delta', mid, data };
}

const ONE = envelope('a/1');
const TWO = envelope('b/2', { some: 'payload', n: 42 });

describe('encodeBatch', () => {
  it('sends a lone envelope in the direct shape, without the array brackets', () => {
    const message = encodeBatch([encodeEnvelope(ONE)]);

    expect(message[0]).toBe(WireTag.Envelope);
    expect(message.slice(1)).toBe(encodeEnvelope(ONE));
  });

  it('agrees with batchLength for every batch size', () => {
    const encoded = Array.from({ length: 12 }, (_, i) => encodeEnvelope(envelope(`m/${i}`, 'y'.repeat(i * 7))));

    for (let count = 1; count <= encoded.length; count++) {
      const parts = encoded.slice(0, count);

      expect(batchLength(parts.map(p => p.length))).toBe(encodeBatch(parts).length);
    }
  });

  it('measures nothing for an empty batch', () => {
    expect(batchLength([])).toBe(0);
  });
});

describe('decodeWire', () => {
  it('reads back a direct envelope', () => {
    const wire = decodeWire(encodeBatch([encodeEnvelope(ONE)]));

    expect(wire).toEqual({ kind: 'envelopes', envelopes: [ONE] });
  });

  it('reads back every envelope in a batch', () => {
    const wire = decodeWire(encodeBatch([encodeEnvelope(ONE), encodeEnvelope(TWO)]));

    expect(wire).toEqual({ kind: 'envelopes', envelopes: [ONE, TWO] });
  });

  it('reads back a chunk', () => {
    const frame = { c: 'a/1', s: 0, t: 4, p: 'part' };
    const wire = decodeWire(tagChunk(encodeFrame(frame)));

    expect(wire).toEqual({ kind: 'chunk', frame });
  });

  it('keeps the sound envelopes in a batch that also carries a bad one', () => {
    const message = `${WireTag.Batch}[${encodeEnvelope(ONE)},{"not":"an envelope"}]`;

    expect(decodeWire(message)).toEqual({ kind: 'envelopes', envelopes: [ONE] });
  });

  it.each([
    ['a bare envelope, which is no shape any protocol sends', encodeEnvelope(ONE)],
    ['an unknown tag', `9${encodeEnvelope(ONE)}`],
    ['an empty message', ''],
    ['a truncated body', `${WireTag.Envelope}{"v":2,"src":`],
    ['a batch that is not an array', `${WireTag.Batch}${encodeEnvelope(ONE)}`],
    ['a batch of nothing usable', `${WireTag.Batch}[{"nope":1}]`],
    ['a chunk that is not a frame', `${WireTag.Chunk}{"c":"a/1"}`],
    ['an envelope from beyond the supported window', `${WireTag.Envelope}{"v":99,"src":"x","iid":"i","type":"t","mid":"m"}`],
    ['an envelope from below the supported window', `${WireTag.Envelope}{"v":0,"src":"x","iid":"i","type":"t","mid":"m"}`],
  ])('ignores %s', (_label, message) => {
    expect(decodeWire(message)).toBeUndefined();
  });
});

/**
 * Cross-version traffic, which is the whole reason the tag exists rather than a version field
 * alone. A protocol-1 node emits a bare frame and can read nothing else, so these assert the two
 * directions separately: that this build places what such a node sends, and that what it produces
 * for one still has the shape that node parses.
 */
describe('protocol 1', () => {
  const LEGACY: Envelope = { v: PROTOCOL_MIN, src: 'graves', iid: 'iid-old', type: 'announce', mid: 'g/1', data: { version: '1.2.0' } };

  function reassemble(messages: readonly string[]): Envelope | undefined {
    const reassembler = new Reassembler();
    let payload: string | undefined;

    for (const message of messages) {
      const wire = decodeWire(message);

      if (wire?.kind !== 'chunk') { return undefined; }

      payload = reassembler.accept(wire.frame, 0) ?? payload;
    }

    return payload === undefined ? undefined : decodeEnvelope(payload);
  }

  it('reads a bare frame, the shape that predates the tag', () => {
    const messages = encodeLegacy(encodeEnvelope(LEGACY), LEGACY.mid, 2000);

    expect(messages).toHaveLength(1);
    expect(messages[0][0]).toBe('{');
    expect(reassemble(messages)).toEqual(LEGACY);
  });

  it('reassembles a bare-frame envelope split across messages', () => {
    const big: Envelope = { ...LEGACY, data: { blob: 'z'.repeat(6000) } };
    const messages = encodeLegacy(encodeEnvelope(big), big.mid, 500);

    expect(messages.length).toBeGreaterThan(1);
    expect(reassemble(messages)).toEqual(big);
  });

  it('emits frames a protocol-1 reader can parse, tag and all', () => {
    // That reader knows one shape: the message is the frame, JSON straight through, no tag to
    // strip. Asserting the shape here is what stands in for running the old decoder.
    for (const message of encodeLegacy(encodeEnvelope(LEGACY), LEGACY.mid, 200)) {
      expect(message.length).toBeLessThanOrEqual(200);

      const frame: unknown = JSON.parse(message);

      expect(frame).toMatchObject({ c: LEGACY.mid, s: expect.any(Number), t: expect.any(Number), p: expect.any(String) });
    }
  });

  it('accepts an envelope written at the older version', () => {
    const wire = decodeWire(encodeLegacy(encodeEnvelope(LEGACY), LEGACY.mid, 2000)[0]);

    expect(wire?.kind).toBe('chunk');
    expect(reassemble(encodeLegacy(encodeEnvelope(LEGACY), LEGACY.mid, 2000))?.v).toBe(PROTOCOL_MIN);
  });
});
