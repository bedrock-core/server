import { describe, expect, it } from 'vitest';
import { cloneData, freezeData } from '../src/data';
import { Reassembler, splitIntoFrames, decodeFrame } from '../src/chunk';
import { decodeEnvelope, encodeEnvelope, type Envelope } from '../src/envelope';
import { decodeWire, encodeBatch } from '../src/wire';
import { PROTOCOL_MAX } from '../src/constants';

function envelope(data: unknown): Envelope {
  return { v: PROTOCOL_MAX, src: 'owner', iid: 'owner/1', dst: 'reader', mid: 'owner/1/1', type: 'data', data };
}

function expectCopy<T>(value: unknown, source: T): asserts value is T {
  expect(cloneData(value)).toEqual(source);
}

describe('structured application data', () => {
  it('preserves nested undefined, array holes and exact numeric values', () => {
    const input = { z: undefined, a: 1, nested: { last: -0, first: [undefined, null, 2] } };
    const expected = input;
    const encoded = encodeEnvelope(envelope(input));

    expect(decodeEnvelope(encoded)?.data).toEqual(expected);
    expect(cloneData(input)).toEqual(expected);
    const array = [undefined, undefined, NaN, Infinity, -Infinity, -0, BigInt('9007199254740993')];

    Reflect.deleteProperty(array, '1');
    const result = cloneData(array);

    expect(result).toEqual(array);
    expect(Array.isArray(result) && Object.hasOwn(result, 0)).toBe(true);
    expect(Array.isArray(result) && Object.hasOwn(result, 1)).toBe(false);
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
    const expected = input;
    const encoded = encodeEnvelope(input);
    const ordinary = envelope({ ordinary: true });

    expect(decodeWire(encodeBatch([encoded]))).toEqual({ kind: 'envelopes', envelopes: [expected] });
    expect(decodeWire(encodeBatch([encoded, encodeEnvelope(ordinary)]))).toEqual({ kind: 'envelopes', envelopes: [expected, ordinary] });
  });

  it('rejects unsupported executable, weak and symbolic values', () => {
    for (const input of [Symbol('x'), (): void => {}, new WeakMap(), new WeakSet(), Promise.resolve(1), { nested: (): void => {} }]) {
      expect(() => cloneData(input)).toThrow();
    }

    expect(() => cloneData({ [Symbol('key')]: 1 })).toThrow();
  });

  it('does not interpret application data as encoding instructions', () => {
    for (const input of [[0], [4], [1, null], { encoding: 1, data: [0] }]) {
      expect(decodeEnvelope(encodeEnvelope(envelope(input)))?.data).toEqual(input);
    }
  });

  it('keeps ordinary JSON payloads in their compact wire representation', () => {
    const input = envelope({ values: [null, true, 4, 'plain'], object: { key: 'value' } });

    expect(encodeEnvelope(input)).toBe(JSON.stringify(input));
    expect(encodeEnvelope({ ...input, v: 1 })).toBe(JSON.stringify({ ...input, v: 1 }));
    expect(() => encodeEnvelope({ ...input, v: 2, data: new Map() })).toThrow('protocol 3');
  });

  it('reads accessors once and preserves safe own properties on objects and sparse arrays', () => {
    let reads = 0;
    const input = { before: { count: 1 }, get current(): { count: number } {
      reads++;

      return { count: reads };
    }, after: new Map([['value', 1]]) };
    const result = cloneData(input);

    expect(reads).toBe(1);
    expect(result.current.count).toBe(1);
    const object = Object.fromEntries([['__proto__', { value: 1 }], ['constructor', 'data']]);
    const array = Object.assign(new Array<unknown>(3), { extra: object });

    Reflect.set(array, '4294967295', 'property');
    const copy = cloneData(array);

    expect(copy.length).toBe(3);
    expect(Object.keys(copy)).toEqual(Object.keys(array));
    expect(Object.hasOwn(copy.extra, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copy.extra)).toBe(Object.prototype);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('retains collection keys, aliases and cycles in direct, batched and chunked messages', () => {
    const key = { id: 'player' };
    const input = { key, alias: key, map: new Map<object, unknown>([[key, new Set([key])]]), self: null as unknown };

    input.self = input;
    input.map.set(input, input.map);
    const encoded = encodeEnvelope(envelope(input));
    const reassembler = new Reassembler();
    let assembled: string | undefined;

    for (const frame of splitIntoFrames(encoded, 'graph', 180)) {
      const parsed = decodeFrame(frame);

      if (parsed) { assembled = reassembler.accept(parsed, 0) ?? assembled; }
    }

    const direct = decodeEnvelope(encoded)?.data;
    const batched = decodeWire(encodeBatch([encoded, encodeEnvelope(envelope('second'))]));
    const chunked = decodeEnvelope(assembled ?? '')?.data;

    for (const value of [direct, batched?.kind === 'envelopes' ? batched.envelopes[0].data : undefined, chunked]) {
      expectCopy(value, input);
      const result = value;

      expect(result).not.toBe(input);
      expect(result.self).toBe(result);
      expect(result.key).toBe(result.alias);
      expect(result.map.get(result)).toBe(result.map);
      const items = result.map.get(result.key);

      expect(items instanceof Set && items.has(result.key)).toBe(true);
    }
  });

  it('copies Date, RegExp and views while preserving shared buffers and offsets', () => {
    const buffer = new ArrayBuffer(16);
    const bytes = new Uint8Array(buffer, 4, 8);
    const words = new Uint16Array(buffer, 4, 4);
    const data = new DataView(buffer, 4, 8);
    const expression = /items/gi;

    bytes.set([1, 2, 3, 4]);
    expression.lastIndex = 7;
    const input = { buffer, bytes, words, data, expression, date: new Date('2026-11-09T00:00:00Z'), invalid: new Date(NaN) };
    const result = decodeEnvelope(encodeEnvelope(envelope(input)))?.data;

    expectCopy(result, input);

    expect(result.date.getTime()).toBe(input.date.getTime());
    expect(Number.isNaN(result.invalid.getTime())).toBe(true);
    expect(result.expression.source).toBe(expression.source);
    expect(result.expression.flags).toBe(expression.flags);
    expect(result.expression.lastIndex).toBe(7);
    expect(result.buffer).not.toBe(buffer);
    expect(result.bytes.buffer).toBe(result.buffer);
    expect(result.words.buffer).toBe(result.buffer);
    expect(result.data.buffer).toBe(result.buffer);
    expect(result.bytes.byteOffset).toBe(4);
    expect([...result.bytes]).toEqual([...bytes]);
  });

  it('guards collection snapshots, nested values and callback escape paths', () => {
    const source = { map: new Map([['key', { amount: 1 }]]), set: new Set([1]), date: new Date(0), bytes: new Uint8Array([1, 2]) };
    const result = freezeData(cloneData(source));

    expectCopy(result, source);

    expect(() => result.map.set('other', { amount: 2 })).toThrow('read-only');
    expect(() => result.set.add(2)).toThrow('read-only');
    expect(() => { result.map.get('key')!.amount = 2; }).toThrow();
    expect(() => result.date.setTime(2)).toThrow('read-only');
    expect(() => result.bytes.fill(3)).toThrow('read-only');
    expect(() => { result.bytes[0] = 4; }).toThrow('read-only');
    result.map.forEach((_item, _key, map) => expect(() => map.clear()).toThrow('read-only'));
    result.bytes.forEach((_item, _key, bytes) => expect(() => bytes.fill(5)).toThrow('read-only'));
    new Uint8Array(result.bytes.buffer)[0] = 9;
    expect(result.bytes[0]).toBe(1);
    expect(cloneData(result)).toEqual(source);
    source.map.set('other', { amount: 3 });
    expect(result.map.has('other')).toBe(false);
    expect(freezeData(result)).toBe(result);
  });

  it('rejects malformed structured payloads while retaining valid neighboring messages', () => {
    const good = encodeEnvelope(envelope('good'));
    const bad = JSON.stringify({ ...envelope(['ref', 9]), encoding: { v: 1, nodes: [] } });

    expect(decodeEnvelope(bad)).toBeUndefined();
    expect(decodeWire(encodeBatch([bad, good]))).toEqual({ kind: 'envelopes', envelopes: [envelope('good')] });
    expect(decodeEnvelope(JSON.stringify({ ...envelope('x'), encoding: { v: 99, nodes: [] } }))).toBeUndefined();
  });
});
