/**
 * Wire-shape invariants.
 *
 * Two things here are load-bearing beyond their size. `batchLength` must agree with `encodeBatch`
 * exactly, because the queue decides what still fits by asking the former and then sends the
 * latter — a disagreement of one character is a message over the engine's cap, dropped at send
 * time with nothing but a counter to show for it. And `decodeWire` must be incurious about input
 * it does not recognise, since the same channel carries traffic from nodes on other protocol
 * versions.
 */
import { describe, expect, it } from 'vitest';
import { encodeFrame } from '../src/chunk';
import { PROTOCOL_VERSION, WireTag } from '../src/constants';
import { type Envelope, encodeEnvelope } from '../src/envelope';
import { batchLength, decodeWire, encodeBatch, tagChunk } from '../src/wire';

function envelope(mid: string, data: unknown = 'x'): Envelope {
  return { v: PROTOCOL_VERSION, src: 'test', iid: 'iid-1', type: 'state-delta', mid, data };
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
    ['a message from a node on the previous protocol', encodeEnvelope(ONE)],
    ['an unknown tag', `9${encodeEnvelope(ONE)}`],
    ['an empty message', ''],
    ['a truncated body', `${WireTag.Envelope}{"v":2,"src":`],
    ['a batch that is not an array', `${WireTag.Batch}${encodeEnvelope(ONE)}`],
    ['a batch of nothing usable', `${WireTag.Batch}[{"nope":1}]`],
    ['a chunk that is not a frame', `${WireTag.Chunk}{"c":"a/1"}`],
    ['an envelope from a mismatched protocol version', `${WireTag.Envelope}{"v":99,"src":"x","iid":"i","type":"t","mid":"m"}`],
  ])('ignores %s', (_label, message) => {
    expect(decodeWire(message)).toBeUndefined();
  });
});
