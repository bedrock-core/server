import type { ConfigValue, FlatSchema } from '../schema';

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
 * Given a set of changed flat paths, return every affected path from deepest
 * to shallowest (leaf → ancestor groups → root '').
 * Callers use this to fire onChange listeners in the right order.
 */
export function collectAffectedPaths(changes: Map<string, ConfigValue>): string[] {
  const paths = new Set<string>(['']);

  for (const key of changes.keys()) {
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

    if (schema?.[path]?.type === 'list' && typeof value === 'string') {
      obj[leaf] = parseListValue(value);
    } else {
      obj[leaf] = value;
    }
  }

  return result;
}
