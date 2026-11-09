import { describe, expect, it, vi } from 'vitest';
import { decodeArguments, encodeArguments, freezeApiData, transformData } from '../src/api/codec';
import type { ApiDataShape, ApiParametersShape } from '../src/api/types';
import { cloneData } from '@bedrock-core/sync/data';

vi.mock('@minecraft/server', () => ({}));

class Marker {}

const marker: ApiDataShape = { kind: 'codec', codec: {
  encode: () => null,
  decode: (value) => {
    if (value !== null) { throw new TypeError('expected null marker'); }

    return new Marker();
  },
} };

describe('API value transport', () => {
  it('maps missing references according to declared nullability and rejects malformed references', () => {
    const context = { references: { encode: (): string => 'gone', decode: (value: unknown): undefined => {
      if (typeof value !== 'string' || value.length === 0) { throw new TypeError('invalid locator'); }

      return undefined;
    } } };

    expect(transformData('gone', { kind: 'reference', reference: 'entity', missing: 'undefined' }, 'decode', context)).toBeUndefined();
    expect(transformData('gone', { kind: 'reference', reference: 'entity', missing: 'null' }, 'decode', context)).toBeNull();
    expect(() => transformData('gone', { kind: 'reference', reference: 'entity' }, 'decode', context)).toThrow('unavailable');
    expect(() => transformData({ id: 'gone' }, { kind: 'reference', reference: 'entity' }, 'decode', context)).toThrow('invalid locator');
    expect(() => transformData('', { kind: 'reference', reference: 'player' }, 'decode', context)).toThrow('invalid locator');
    expect(() => transformData('gone', { kind: 'reference', reference: 'entity' }, 'decode')).toThrow('reference adapters');
  });

  it('freezes nested containers and value classes without traversing live references', () => {
    const entity = { get nativeProperty(): never { throw new Error('native handle traversed'); } };
    const reference = { kind: 'reference', reference: 'entity' } as const;
    const shape: ApiDataShape = { kind: 'object', members: {
      tuple: { kind: 'tuple', items: [reference, marker], rest: reference },
      dictionary: { kind: 'object', members: {}, index: reference },
    } };
    const value = { tuple: [entity, new Marker(), entity], dictionary: { first: entity }, json: { value: 1 }, constructor: { name: 'data' } };

    expect(freezeApiData(value, shape)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.tuple)).toBe(true);
    expect(Object.isFrozen(value.tuple[1])).toBe(true);
    expect(Object.isFrozen(value.dictionary)).toBe(true);
    expect(Object.isFrozen(value.json)).toBe(true);
    expect(Object.isFrozen(value.constructor)).toBe(true);
    expect(Object.isFrozen(entity)).toBe(false);
  });

  it('distinguishes nullable values from instances whose codec encodes null', () => {
    const shape: ApiParametersShape = { items: [{ kind: 'array', item: marker }, marker, marker] };
    const wire: unknown = JSON.parse(JSON.stringify(encodeArguments([[new Marker(), null], null, undefined], shape)));
    const decoded = decodeArguments(wire, shape);

    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toEqual([new Marker(), null]);
    expect(Array.isArray(decoded[0]) && decoded[0][0]).toBeInstanceOf(Marker);
    expect(decoded[1]).toBeNull();
    expect(decoded[2]).toBeUndefined();
  });

  it('rejects malformed class payloads and propagates codec validation failures', () => {
    expect(() => transformData({}, marker, 'decode')).toThrow('invalid encoded API value');
    expect(() => transformData([1], marker, 'decode')).toThrow('expected null marker');
    expect(() => transformData(new Marker(), { kind: 'codec', codec: { encode: () => undefined, decode: () => new Marker() } }, 'encode'))
      .toThrow('defined data');
    expect(() => decodeArguments({ args: [1], missing: [0] })).toThrow('invalid addon API argument position');
  });

  it('preserves structured values in codec data and unrelated object fields', () => {
    const shape: ApiDataShape = { kind: 'object', members: { marker } };
    const encoded = transformData({ marker: new Marker(), omitted: undefined, numbers: [-0, undefined] }, shape, 'encode');
    const decoded = transformData(cloneData(encoded), shape, 'decode');

    expect(decoded).toEqual({ marker: new Marker(), omitted: undefined, numbers: [-0, undefined] });
    expect(typeof decoded === 'object' && decoded !== null && Object.hasOwn(decoded, 'omitted')).toBe(true);
  });
});
