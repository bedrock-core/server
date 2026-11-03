/** Copy published data using the same JSON semantics as the wire. */
export function cloneData(value: unknown): unknown {
  if (value === undefined) { return undefined; }

  const json = JSON.stringify(value);

  // JSON.stringify can return undefined for a top-level function, symbol, or value
  // whose toJSON() returns undefined, despite TypeScript declaring a string return.
  // JSON.parse requires JSON text.
  if (json === undefined) { throw new TypeError('[sync] value cannot be serialized as JSON'); }

  const copy: unknown = JSON.parse(json);

  return copy;
}

/** Read-only API views freeze their copied snapshots, never the authored source. */
export function freezeData(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) { freezeData(nested); }

    Object.freeze(value);
  }

  return value;
}
