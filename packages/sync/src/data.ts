import { decodeData, encodeData, snapshotSources } from './values';

export { decodeData, encodeData, type EncodedData } from './values';

/** Copy application values with the same structured semantics as the wire. */
export function cloneData<T>(value: T): T;

export function cloneData(value: unknown): unknown {
  const encoded = encodeData(value);

  return encoded.nodes === undefined ? encoded.value : decodeData(encoded.value, encoded.nodes);
}

const snapshots = new WeakMap<object, unknown>();

const immutable = (): never => { throw new TypeError('API snapshots are read-only'); };

/** Freeze a copied graph, guarding collection mutations and leaving opaque handles alone. */
export function freezeData<T>(value: T, opaque?: WeakSet<object>): T;

export function freezeData(value: unknown, opaque?: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null || opaque?.has(value)) { return value; }

  if (snapshots.has(value)) { return snapshots.get(value); }

  const collection = value instanceof Map || value instanceof Set;
  const date = value instanceof Date;
  const view = ArrayBuffer.isView(value);
  let result: object = value;

  if (collection || date || view || value instanceof ArrayBuffer) {
    result = new Proxy(value, {
      get(target, key, receiver): unknown {
        if (date && key === Symbol.toStringTag) { return 'Date'; }

        if (key === 'valueOf' && !date) { return (): object => receiver; }

        if ((collection && ['set', 'add', 'delete', 'clear'].includes(String(key))) || (date && String(key).startsWith('set'))
          || (view && (['set', 'copyWithin', 'fill', 'reverse', 'sort'].includes(String(key)) || (target instanceof DataView && String(key).startsWith('set'))))
          || (target instanceof ArrayBuffer && ['resize', 'transfer', 'transferToFixedLength'].includes(String(key)))) { return immutable; }

        if (ArrayBuffer.isView(target) && key === 'buffer') { return target.buffer.slice(0); }

        const member: unknown = Reflect.get(target, key, target);

        if (typeof member !== 'function' || key === 'constructor') { return member; }

        if ((collection && key === 'forEach') || (view && ['forEach', 'map', 'filter', 'every', 'some', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'reduceRight'].includes(String(key)))) {
          return (callback: (...args: unknown[]) => unknown, ...args: unknown[]): unknown => Reflect.apply(member, target, [
            (...items: unknown[]): unknown => Reflect.apply(callback, String(key).startsWith('reduce') ? undefined : args[0], [...items.slice(0, -1), receiver]), ...args,
          ]);
        }

        if (view && key === 'subarray') { return (...args: unknown[]): unknown => freezeData(Reflect.apply(member, target, args)); }

        return member.bind(target);
      },
      set: immutable,
      defineProperty: immutable,
      deleteProperty: immutable,
      setPrototypeOf: immutable,
    });
  }

  snapshots.set(value, result);
  snapshots.set(result, result);

  if (result !== value) { snapshotSources.set(result, value); }

  if (value instanceof Map) {
    const entries = [...value];

    value.clear();

    for (const [key, item] of entries) { value.set(freezeData(key, opaque), freezeData(item, opaque)); }
  } else if (value instanceof Set) {
    const items = [...value];

    value.clear();

    for (const item of items) { value.add(freezeData(item, opaque)); }
  } else if (!date && !view && !(value instanceof ArrayBuffer)) {
    for (const [key, item] of Object.entries(value)) {
      const frozen = freezeData(item, opaque);

      if (frozen !== item) { Object.defineProperty(value, key, { value: frozen, enumerable: true, configurable: true, writable: true }); }
    }
  }

  if (!view) { Object.freeze(value); }

  return result;
}
