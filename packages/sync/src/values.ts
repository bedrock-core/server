type Token = null | boolean | number | string | readonly unknown[];
type Node = readonly unknown[];

/** Original copied values behind the read-only snapshot views. */
export const snapshotSources = new WeakMap<object, object>();

/** An application value and, when necessary, its explicitly encoded object graph. */
export interface EncodedData {
  value: unknown;
  nodes?: readonly Node[];
}

const views = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
const viewName = (name: string): name is keyof typeof views => Object.hasOwn(views, name);

const invalid = (): never => { throw new TypeError('[sync] invalid structured data'); };

const structuredValue = Symbol('structured value');

/** Copy ordinary data without allocating a graph table or evaluating accessors. */
function plainCopy(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0))) { return value; }

  if (typeof value !== 'object' || value === null || snapshotSources.has(value) || seen.has(value)) { return structuredValue; }

  const array = Array.isArray(value);

  if (!array && Object.getPrototypeOf(value) !== Object.prototype) { return structuredValue; }

  if (Object.getOwnPropertySymbols(value).some(key => Object.prototype.propertyIsEnumerable.call(value, key))) { return structuredValue; }

  seen.add(value);
  const keys = Object.keys(value);

  const property = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    return descriptor && 'value' in descriptor ? plainCopy(descriptor.value, seen) : structuredValue;
  };

  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) { return structuredValue; }

    const result: unknown[] = new Array(value.length);

    for (let index = 0; index < value.length; index++) {
      const item = property(String(index));

      if (item === structuredValue) { return structuredValue; }

      result[index] = item;
    }

    return result;
  }

  const result: Record<string, unknown> = {};

  for (const key of keys) {
    const item = property(key);

    if (item === structuredValue) { return structuredValue; }

    if (key === '__proto__') { Object.defineProperty(result, key, { value: item, enumerable: true, configurable: true, writable: true }); } else { result[key] = item; }
  }

  return result;
}

/** Encode values without interpreting application properties as transport instructions. */
export function encodeData(value: unknown): EncodedData {
  if (value === undefined) { return { value }; }

  const ordinary = plainCopy(value, new WeakSet());

  if (ordinary !== structuredValue) { return { value: ordinary }; }

  const nodes: Node[] = [];
  const seen = new Map<object, number>();

  const visit = (input: unknown): Token => {
    if (typeof input === 'object' && input !== null) { input = snapshotSources.get(input) ?? input; }

    if (input === undefined) { return ['undefined']; }

    if (typeof input === 'bigint') { return ['bigint', String(input)]; }

    if (typeof input === 'number' && (!Number.isFinite(input) || Object.is(input, -0))) {
      return ['number', Object.is(input, -0) ? '-0' : String(input)];
    }

    if (input === null || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') { return input; }

    if (typeof input !== 'object') { throw new TypeError(`[sync] unsupported data value: ${typeof input}`); }

    const previous = seen.get(input);

    if (previous !== undefined) { return ['ref', previous]; }

    const id = nodes.length;

    seen.set(input, id);
    nodes.push([]);

    if (input instanceof Map) {
      nodes[id] = ['map', [...input].map(([key, item]) => [visit(key), visit(item)])];
    } else if (input instanceof Set) {
      nodes[id] = ['set', [...input].map(visit)];
    } else if (input instanceof Date) {
      nodes[id] = ['date', visit(input.getTime())];
    } else if (input instanceof RegExp) {
      nodes[id] = ['regexp', input.source, input.flags, visit(input.lastIndex)];
    } else if (input instanceof ArrayBuffer) {
      nodes[id] = ['buffer', [...new Uint8Array(input)]];
    } else if (ArrayBuffer.isView(input)) {
      const name = input.constructor.name;

      if (name !== 'DataView' && !Object.hasOwn(views, name)) { throw new TypeError(`[sync] unsupported data view: ${name}`); }

      nodes[id] = ['view', name, visit(input.buffer), input.byteOffset, input.byteLength];
    } else {
      const array = Array.isArray(input);
      const length = Array.isArray(input) ? input.length : 0;
      const prototype: object | null = Object.getPrototypeOf(input);

      if (!array && prototype !== Object.prototype && prototype !== null) { throw new TypeError('[sync] unsupported data object; use a value codec or API reference'); }

      if (Object.getOwnPropertySymbols(input).some(key => Object.prototype.propertyIsEnumerable.call(input, key))) { throw new TypeError('[sync] symbol data keys are unsupported'); }

      const entries: [string, Token][] = [];

      for (const [key, item] of Object.entries(input)) {
        const token = visit(item);

        entries.push([key, token]);
      }

      nodes[id] = array ? ['array', length, entries] : [prototype === null ? 'null-object' : 'object', entries];
    }

    return ['ref', id];
  };

  return { value: visit(value), nodes };
}

/** Rebuild one message's values, retaining cycles, aliases and collection keys. */
export function decodeData(value: unknown, nodes: readonly Node[]): unknown {
  const copies: unknown[] = new Array(nodes.length);
  const filling = new Set<number>();

  const read = (token: unknown): unknown => {
    if (token === null || typeof token === 'string' || typeof token === 'boolean' || (typeof token === 'number' && Number.isFinite(token))) { return token; }

    if (!Array.isArray(token)) { return invalid(); }

    if (token[0] === 'undefined' && token.length === 1) { return undefined; }

    if (token[0] === 'bigint' && token.length === 2 && typeof token[1] === 'string' && /^-?(0|[1-9]\d*)$/.test(token[1])) { return BigInt(token[1]); }

    if (token[0] === 'number' && token.length === 2) {
      switch (token[1]) {
        case '-0': return -0;
        case 'NaN': return NaN;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
      }
    }

    if (token[0] !== 'ref' || token.length !== 2 || !Number.isInteger(token[1]) || token[1] < 0 || token[1] >= nodes.length) { return invalid(); }

    const id: number = token[1];

    if (Object.hasOwn(copies, id)) { return copies[id]; }

    if (filling.has(id)) { return invalid(); }

    const node = nodes[id];

    if (!Array.isArray(node)) { return invalid(); }

    filling.add(id);
    let copy: unknown;

    const entries = (items: unknown, apply: (key: unknown, item: unknown) => void): void => {
      if (!Array.isArray(items)) { return invalid(); }

      for (const entry of items) {
        if (!Array.isArray(entry) || entry.length !== 2) { return invalid(); }

        apply(entry[0], entry[1]);
      }
    };

    switch (node[0]) {
      case 'object':
      case 'null-object':

        // Fall through to the shared own-property decoder.
      case 'array': {
        const array = node[0] === 'array';

        if (array && (!Number.isInteger(node[1]) || Number(node[1]) < 0 || Number(node[1]) > 0xffffffff)) { return invalid(); }

        const result: object = array ? new Array(Number(node[1])) : Object.create(node[0] === 'null-object' ? null : Object.prototype);

        copies[id] = result;
        entries(node[array ? 2 : 1], (key, item) => {
          if (typeof key !== 'string' || (array && (key === 'length' || (/^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff && Number(key) >= Number(node[1]))))) { return invalid(); }

          Object.defineProperty(result, key, { value: read(item), enumerable: true, writable: true, configurable: true });
        });
        copy = result;
        break;
      }

      case 'map': {
        const result = new Map<unknown, unknown>();

        copies[id] = result;
        entries(node[1], (key, item) => result.set(read(key), read(item)));
        copy = result;
        break;
      }

      case 'set': {
        const result = new Set<unknown>();

        copies[id] = result;

        if (!Array.isArray(node[1])) { return invalid(); }

        for (const item of node[1]) { result.add(read(item)); }

        copy = result;
        break;
      }

      case 'date': {
        const time = read(node[1]);

        if (typeof time !== 'number') { return invalid(); }

        copy = new Date(time);
        break;
      }

      case 'regexp': {
        if (typeof node[1] !== 'string' || typeof node[2] !== 'string') { return invalid(); }

        const result = new RegExp(node[1], node[2]);
        const index = read(node[3]);

        if (typeof index !== 'number') { return invalid(); }

        result.lastIndex = index;
        copy = result;
        break;
      }

      case 'buffer': {
        if (!Array.isArray(node[1]) || node[1].some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) { return invalid(); }

        copy = new Uint8Array(node[1]).buffer;
        break;
      }

      case 'view': {
        const buffer = read(node[2]);
        const name = node[1];
        const offset = node[3];
        const length = node[4];

        if (!(buffer instanceof ArrayBuffer) || typeof name !== 'string' || (name !== 'DataView' && !viewName(name))
          || !Number.isInteger(offset) || Number(offset) < 0 || !Number.isInteger(length) || Number(length) < 0) { return invalid(); }

        if (name === 'DataView') { copy = new DataView(buffer, Number(offset), Number(length)); } else {
          if (!viewName(name)) { return invalid(); }

          const constructor = views[name];

          if (Number(length) % constructor.BYTES_PER_ELEMENT !== 0) { return invalid(); }

          copy = new constructor(buffer, Number(offset), Number(length) / constructor.BYTES_PER_ELEMENT);
        }

        break;
      }

      default: return invalid();
    }

    copies[id] = copy;
    filling.delete(id);

    return copy;
  };

  return read(value);
}
