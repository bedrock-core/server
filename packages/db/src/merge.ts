/**
 * Deep merging for JSON documents: what `patch` does to a stored document, and what `defaults`
 * do to one being read.
 *
 * A plain object merges key by key, recursively. Anything else — a scalar, an array, `null` —
 * replaces what was there: an array is a value, not a container, so a patch that names one
 * replaces the whole array. `undefined` in a patch deletes the key, which is how a caller puts a
 * key back to its default without knowing what the default is.
 */

/** A patch for `T`: every key optional at every depth; an array is replaced whole. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K]
    : T[K] extends object ? DeepPartial<T[K]>
      : T[K]
};

/** A non-null, non-array object: what merges as structure rather than replacing as a value. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `base` with `changes` merged in. Neither input is mutated. */
export function merge(base: Record<string, unknown> | undefined, changes: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(changes)) {
    const change = changes[key];

    if (change === undefined) {
      delete result[key];
    } else if (isPlainObject(change) && isPlainObject(result[key])) {
      result[key] = merge(result[key], change);
    } else {
      result[key] = change;
    }
  }

  return result;
}

/**
 * `doc` with every key it lacks taken from `defaults`, at every depth.
 *
 * A default is handed over by reference, not cloned: a document is treated as immutable and
 * changed with `patch`, so nothing should be writing into one.
 */
export function fill(defaults: Record<string, unknown> | undefined, doc: Record<string, unknown>): Record<string, unknown> {
  if (defaults === undefined) {
    return doc;
  }

  const result: Record<string, unknown> = { ...doc };

  for (const key of Object.keys(defaults)) {
    const fallback = defaults[key];
    const present = result[key];

    if (present === undefined) {
      result[key] = fallback;
    } else if (isPlainObject(fallback) && isPlainObject(present)) {
      result[key] = fill(fallback, present);
    }
  }

  return result;
}
