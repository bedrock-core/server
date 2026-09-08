/**
 * What the schema says about a scope's document.
 *
 * A scope's values are one db document shaped exactly like the schema: a group is a nested
 * object, a leaf is its value. Only overrides are stored — a key at its schema default is absent —
 * so a later change to a default reaches every target that never touched the setting. Two things
 * follow from the schema and are handed to db as the collection's `defaults` and `normalize`:
 * the complete default document, and the write-time pass that coerces every value to what its
 * entry allows, drops the ones back at their default, and drops keys the schema does not name.
 */
import type { ConfigEntry, ConfigValue, SchemaGroup } from './schema';
import { childEntries, isEntry } from './schema';

/** A scope's document: groups nest, leaves hold their value. */
export type ConfigDocument = Record<string, unknown>;

/** Every schema key at its default, nested as the schema is. */
export function defaultsOf(tree: SchemaGroup): ConfigDocument {
  const result: ConfigDocument = {};

  for (const [key, node] of childEntries(tree)) {
    result[key] = isEntry(node) ? node.default : defaultsOf(node);
  }

  return result;
}

/**
 * The write-time pass for a scope's documents. What comes back holds only overrides: every value
 * coerced to its entry, none equal to its default, nothing the schema does not name.
 */
export function normalizeAgainst(tree: SchemaGroup): (doc: ConfigDocument) => ConfigDocument {
  return (doc: ConfigDocument): ConfigDocument => overridesOf(tree, doc);
}

function overridesOf(tree: SchemaGroup, doc: ConfigDocument): ConfigDocument {
  const result: ConfigDocument = {};

  for (const [key, node] of childEntries(tree)) {
    const value = doc[key];

    if (value === undefined) { continue; }

    if (isEntry(node)) {
      const coerced = coerce(value, node);

      if (!sameValue(coerced, node.default)) { result[key] = coerced; }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // The index signature already types a group's children as objects; this is that narrowing.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const nested = overridesOf(node, value as ConfigDocument);

      if (Object.keys(nested).length > 0) { result[key] = nested; }
    }
  }

  return result;
}

/** `value` as the entry allows it, or the entry's default when it cannot be made to fit. */
export function coerce(value: unknown, entry: ConfigEntry): ConfigValue {
  switch (entry.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : entry.default;

    case 'number': {
      const number = typeof value === 'number' ? value : Number(value);

      if (!Number.isFinite(number)) { return entry.default; }

      return Math.min(entry.max, Math.max(entry.min, number));
    }

    case 'string': {
      if (typeof value !== 'string') { return entry.default; }

      return entry.maxLength !== undefined && value.length > entry.maxLength ? value.slice(0, entry.maxLength) : value;
    }

    case 'enum':
      return typeof value === 'string' && entry.options.includes(value) ? value : entry.default;

    case 'list': {
      if (!Array.isArray(value)) { return entry.default; }

      const options = entry.options;
      const items = value.filter((item): item is string => typeof item === 'string' && (options === undefined || options.includes(item)));

      return entry.maxItems !== undefined && items.length > entry.maxItems ? items.slice(0, entry.maxItems) : items;
    }

    case 'multiselect':
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && entry.options.includes(item)) : entry.default;
  }
}

/** Structural equality over what a document holds: scalars, arrays, plain objects. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) { return true; }

  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { return false; }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  return keysA.length === keysB.length
    && keysA.every(key => Object.hasOwn(b, key) && sameValue((a as ConfigDocument)[key], (b as ConfigDocument)[key])); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}

/** The value at `path` inside `value`, or `undefined` when the path runs off the object. */
export function getIn(value: unknown, path: readonly string[]): unknown {
  let node = value;

  for (const key of path) {
    if (typeof node !== 'object' || node === null) { return undefined; }

    node = (node as ConfigDocument)[key]; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  return node;
}

/** `doc` with the subtree at `path` replaced by `value`. `doc` is not mutated; an empty path gives `value` itself. */
export function setIn(doc: ConfigDocument | undefined, path: readonly string[], value: unknown): ConfigDocument {
  if (path.length === 0) {
    // The caller's `set` on a scope root passes the whole document.
    return value as ConfigDocument; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  const [head, ...rest] = path;
  const current = doc?.[head];
  const inner = typeof current === 'object' && current !== null && !Array.isArray(current) ? current as ConfigDocument : undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

  return { ...doc, [head]: setIn(inner, rest, value) };
}

/** `value` nested under `path`: `wrap(['a', 'b'], 1)` is `{ a: { b: 1 } }`. */
export function wrap(path: readonly string[], value: unknown): ConfigDocument {
  let node: unknown = value;

  for (let i = path.length - 1; i >= 0; i--) {
    node = { [path[i]]: node };
  }

  return node as ConfigDocument; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}
