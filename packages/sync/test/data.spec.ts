import { describe, expect, it } from 'vitest';
import { cloneData, freezeData } from '../src/data';
import { decodeEnvelope, encodeEnvelope, type Envelope } from '../src/envelope';
import { decodeWire, encodeBatch } from '../src/wire';
import { PROTOCOL_MAX } from '../src/constants';

function envelope(data: unknown): Envelope {
  return { v: PROTOCOL_MAX, src: 'owner', iid: 'owner/1', dst: 'reader', mid: 'owner/1/1', type: 'data', data };
}

describe('JSON application data', () => {
  it('uses native JSON semantics for undefined fields, array entries and negative zero', () => {
    const input = { z: undefined, a: 1, nested: { last: -0, first: [undefined, null, 2] } };
    const expected = { a: 1, nested: { last: 0, first: [null, null, 2] } };
    const encoded = encodeEnvelope(envelope(input));

    expect(encoded).toBe(JSON.stringify(envelope(input)));
    expect(decodeEnvelope(encoded)?.data).toEqual(expected);
    expect(cloneData(input)).toEqual(expected);
  });

  it('copies and freezes snapshots without freezing or sharing the source', () => {
    const source = { z: 2, a: { first: 1 }, values: [1, 2] };
    const copy = cloneData(source);

    freezeData(copy);
    source.a.first = 3;
    source.values.push(4);
    expect(copy).toEqual({ z: 2, a: { first: 1 }, values: [1, 2] });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(source.a)).toBe(false);
    expect(cloneData(undefined)).toBeUndefined();
  });

  it('uses the same data semantics in single and batched wire messages', () => {
    const input = envelope({ fields: [undefined, -0], empty: undefined });
    const expected = envelope({ fields: [null, 0] });
    const encoded = encodeEnvelope(input);
    const ordinary = envelope({ ordinary: true });

    expect(decodeWire(encodeBatch([encoded]))).toEqual({ kind: 'envelopes', envelopes: [expected] });
    expect(decodeWire(encodeBatch([encoded, encodeEnvelope(ordinary)]))).toEqual({ kind: 'envelopes', envelopes: [expected, ordinary] });
  });

  it('reports JSON serialization failures before publishing a copy', () => {
    const cycle: Record<string, unknown> = {};

    cycle.self = cycle;

    for (const input of [BigInt(1), cycle, Symbol('x'), (): void => {}]) {
      expect(() => cloneData(input)).toThrow();
    }

    expect(() => encodeEnvelope(envelope(cycle))).toThrow();
    expect(() => encodeEnvelope(envelope(BigInt(1)))).toThrow();
  });

  it('does not interpret application data as encoding instructions', () => {
    for (const input of [[0], [4], [1, null], { encoding: 1, data: [0] }]) {
      expect(decodeEnvelope(encodeEnvelope(envelope(input)))?.data).toEqual(input);
    }
  });
});
