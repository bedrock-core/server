import type { ConfigValue, FlatSchema } from '../schema';

/**
 * Flatten a nested plain object to dot-path → primitive pairs.
 * Arrays and null are treated as leaf values (not descended into).
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
    } else if (val !== null && typeof val === 'object') {
      for (const [k, v] of flattenObject(val as Record<string, unknown>, path)) {
        result.set(k, v);
      }
    } else if (val !== undefined) {
      result.set(path, val as ConfigValue);
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
 * Reconstruct a nested object from a flat dot-path → value record.
 * Pass a FlatSchema so list entries (stored as JSON strings) are parsed back to arrays.
 */
export function buildNestedObject(flat: Record<string, ConfigValue>, schema?: FlatSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let obj = result;

    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) { obj[parts[i]] = {}; }

      obj = obj[parts[i]] as Record<string, unknown>;
    }

    const leaf = parts[parts.length - 1];

    if (schema?.[path]?.type === 'list' && typeof value === 'string') {
      try { obj[leaf] = JSON.parse(value) as unknown[]; } catch { obj[leaf] = []; }
    } else {
      obj[leaf] = value;
    }
  }

  return result;
}
