import type { ConfigValue, FlatSchema, SchemaGroup } from '../schema';
import { childEntries, childNode, isEntry } from '../schema';
import type { ChangeEmitter } from './change-emitter';

/**
 * A schema subtree: group keys → nested groups or leaf entries, plus the group's own
 * `$label`/`$description`. Walk it with `childEntries`/`childNode`, never `Object.entries` —
 * those are what drop the display strings back out.
 */
export type SchemaTree = SchemaGroup;

/** Flat dot-path → stored value view, as kept by the scopes. */
export type FlatValues = ReadonlyMap<string, ConfigValue>;

/** Non-null object viewed as a string-indexed record (arrays included, as before). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isConfigValue(value: unknown): value is ConfigValue {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Flatten a nested plain object to dot-path → primitive pairs.
 * Arrays are leaf values (stored as JSON strings); leaves that are not valid
 * config values (null, undefined, functions, …) are skipped.
 */
export function flattenObject(
  obj: Record<string, unknown>,
  prefix = '',
): Map<string, ConfigValue> {
  const result = new Map<string, ConfigValue>();

  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (Array.isArray(val)) {
      result.set(path, JSON.stringify(val));
    } else if (isRecord(val)) {
      for (const [k, v] of flattenObject(val, path)) {
        result.set(k, v);
      }
    } else if (isConfigValue(val)) {
      result.set(path, val);
    }
  }

  return result;
}

/**
 * Flatten a value written **at** `path` into the flat changes it implies — the write half of
 * {@link valueAtPath}. `''` is the whole scope (the value is a nested object), a group path
 * prefixes the flattened object, and a leaf path takes the value as-is; arrays are stored as
 * their JSON string, exactly as {@link flattenObject} does.
 */
export function flattenAt(path: string, value: unknown): Map<string, ConfigValue> {
  if (Array.isArray(value)) { return new Map([[path, JSON.stringify(value)]]); }

  if (isRecord(value)) { return flattenObject(value, path); }

  return isConfigValue(value) ? new Map([[path, value]]) : new Map();
}

/**
 * Mark every schema key under `path` that `changes` does not set as a revert-to-default —
 * the `set` half of the write semantics. `''` covers the whole scope, a group path covers its
 * subtree, and a leaf path covers only itself.
 */
export function withRevertsUnder(
  path: string,
  changes: Map<string, ConfigValue>,
  flatSchema: FlatSchema,
): Map<string, ConfigValue | undefined> {
  const full = new Map<string, ConfigValue | undefined>(changes);
  const prefix = `${path}.`;

  for (const key of Object.keys(flatSchema)) {
    if (path !== '' && key !== path && !key.startsWith(prefix)) { continue; }

    if (!full.has(key)) { full.set(key, undefined); }
  }

  return full;
}

/**
 * Given the set of changed flat paths, return every affected path from deepest
 * to shallowest (leaf → ancestor groups → root '').
 * Listeners are fired in that order.
 */
function collectAffectedPaths(changedKeys: Iterable<string>): string[] {
  const paths = new Set<string>(['']);

  for (const key of changedKeys) {
    paths.add(key);
    const parts = key.split('.');

    for (let i = 1; i < parts.length; i++) { paths.add(parts.slice(0, i).join('.')); }
  }

  return [...paths].sort((a, b) => pathDepth(b) - pathDepth(a));
}

function pathDepth(path: string): number {
  return path === '' ? 0 : path.split('.').length;
}

/**
 * Parse a list value back from its stored JSON-string form.
 * Malformed JSON or a non-array payload yields `[]`.
 */
export function parseListValue(raw: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    return isUnknownArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Reconstruct a nested object from a flat dot-path → value record.
 * Pass a FlatSchema so list entries (stored as JSON strings) are parsed back to arrays.
 */
export function buildNestedObject(flat: Record<string, ConfigValue>, schema?: FlatSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let obj = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const existing = obj[parts[i]];

      if (isRecord(existing)) {
        obj = existing;
      } else {
        const child: Record<string, unknown> = {};

        obj[parts[i]] = child;
        obj = child;
      }
    }

    const leaf = parts[parts.length - 1];

    if (isArrayValued(schema?.[path]?.type) && typeof value === 'string') {
      obj[leaf] = parseListValue(value);
    } else {
      obj[leaf] = value;
    }
  }

  return result;
}

// ─── Tree reconstruction (shared by both config scopes) ────────────────────────

/**
 * The entry types whose value is an ARRAY, and so travels as that array's JSON.
 *
 * A stored value is one of `ConfigValue`'s three scalars, so both of these round-trip through a
 * string — the parse back into an array has to key off the schema, since the stored form of an
 * empty list and the stored form of the literal text `[]` are the same two characters.
 */
function isArrayValued(type: string | undefined): boolean {
  return type === 'list' || type === 'multiselect';
}

/** Resolve one leaf: stored value → schema default; array-valued entries parse back to arrays. */
function resolveLeaf(path: string, flatSchema: FlatSchema, values: FlatValues): unknown {
  const raw = values.get(path) ?? flatSchema[path]?.default;

  if (isArrayValued(flatSchema[path]?.type) && typeof raw === 'string') {
    return parseListValue(raw);
  }

  return raw;
}

/** Reconstruct the nested value object for a schema subtree from flat values. */
export function buildTreeValue(
  tree: SchemaTree,
  prefix: string,
  flatSchema: FlatSchema,
  values: FlatValues,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, node] of childEntries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isEntry(node)) {
      result[key] = resolveLeaf(path, flatSchema, values);
    } else {
      result[key] = buildTreeValue(node, path, flatSchema, values);
    }
  }

  return result;
}

/** The value at a dot-path within the tree — `''` is the whole tree; unknown paths yield `undefined`. */
export function valueAtPath(
  tree: SchemaTree,
  path: string,
  flatSchema: FlatSchema,
  values: FlatValues,
): unknown {
  if (path === '') { return buildTreeValue(tree, '', flatSchema, values); }

  const parts = path.split('.');
  let subtree: SchemaTree = tree;
  let prefix = '';

  for (let i = 0; i < parts.length - 1; i++) {
    const node = childNode(subtree, parts[i]);

    if (!node || isEntry(node)) { return undefined; }

    prefix = prefix ? `${prefix}.${parts[i]}` : parts[i];
    subtree = node;
  }

  const last = parts[parts.length - 1];
  const node = childNode(subtree, last);

  if (!node) { return undefined; }

  const nodePath = prefix ? `${prefix}.${last}` : last;

  if (isEntry(node)) { return resolveLeaf(nodePath, flatSchema, values); }

  return buildTreeValue(node, nodePath, flatSchema, values);
}

/**
 * Fire the emitter for every path affected by a batch of flat-key changes (deepest first),
 * reconstructing the next/prev value at each subscribed path.
 */
export function emitAffected(
  emitter: ChangeEmitter,
  changedKeys: Iterable<string>,
  tree: SchemaTree,
  flatSchema: FlatSchema,
  next: FlatValues,
  prev: FlatValues,
): void {
  if (!emitter.hasAny()) { return; }

  for (const path of collectAffectedPaths(changedKeys)) {
    if (!emitter.has(path)) { continue; }

    emitter.emit(path, valueAtPath(tree, path, flatSchema, next), valueAtPath(tree, path, flatSchema, prev));
  }
}
