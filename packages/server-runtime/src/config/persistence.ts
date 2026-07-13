/**
 * Dynamic property persistence for config values.
 *
 * Key scheme:
 *   server scope:       world.getDynamicProperty('bc-cfg:s:<addonId>:<key>')
 *   dimension scope:    world.getDynamicProperty('bc-cfg:d:<addonId>:<dimId>:<key>')
 *   player scope:       player.getDynamicProperty('bc-cfg:p:<addonId>:<key>')
 *
 * All config values are stored as primitives (boolean | number | string).
 * All functions that touch DPs must only be called from tick 1 onward.
 */
import { world } from '@minecraft/server';
import type { Player } from '@minecraft/server';
import type { ConfigValue, FlatSchema, SerializedEntry } from './schema';

// ─── Key builders ──────────────────────────────────────────────────────────────

export function serverDpKey(addonId: string, key: string): string {
  return `bc-cfg:s:${addonId}:${key}`;
}

export function dimensionDpKey(addonId: string, dimId: string, key: string): string {
  return `bc-cfg:d:${addonId}:${dimId}:${key}`;
}

export function playerDpKey(addonId: string, key: string): string {
  return `bc-cfg:p:${addonId}:${key}`;
}

// ─── Load helpers ──────────────────────────────────────────────────────────────

export function loadServerValues(addonId: string, schema: FlatSchema): Map<string, ConfigValue> {
  const values = new Map<string, ConfigValue>();

  for (const [key, entry] of Object.entries(schema)) {
    const raw = toPrimitive(world.getDynamicProperty(serverDpKey(addonId, key)));

    values.set(key, raw !== undefined ? coerce(raw, entry) : entry.default);
  }

  return values;
}

/** Returns only keys that have a stored DP value. Fallback is handled by the scope. */
export function loadDimensionValues(
  addonId: string,
  dimId: string,
  schema: FlatSchema,
): Map<string, ConfigValue> {
  const values = new Map<string, ConfigValue>();

  for (const [key, entry] of Object.entries(schema)) {
    const raw = toPrimitive(world.getDynamicProperty(dimensionDpKey(addonId, dimId, key)));

    if (raw !== undefined) { values.set(key, coerce(raw, entry)); }
  }

  return values;
}

/** Returns only keys that have a stored DP value on the player entity. */
export function loadPlayerValues(
  player: Player,
  addonId: string,
  schema: FlatSchema,
): Map<string, ConfigValue> {
  const values = new Map<string, ConfigValue>();

  for (const [key, entry] of Object.entries(schema)) {
    const raw = toPrimitive(player.getDynamicProperty(playerDpKey(addonId, key)));

    if (raw !== undefined) { values.set(key, coerce(raw, entry)); }
  }

  return values;
}

// ─── Save helpers ──────────────────────────────────────────────────────────────
// `value: undefined` deletes the stored override (used by `set`, which reverts
// keys missing from its input to their schema defaults).

export function saveServerValue(addonId: string, key: string, value: ConfigValue | undefined): void {
  world.setDynamicProperty(serverDpKey(addonId, key), value);
}

export function saveDimensionValue(
  addonId: string,
  dimId: string,
  key: string,
  value: ConfigValue | undefined,
): void {
  world.setDynamicProperty(dimensionDpKey(addonId, dimId, key), value);
}

export function savePlayerValue(
  player: Player,
  addonId: string,
  key: string,
  value: ConfigValue | undefined,
): void {
  player.setDynamicProperty(playerDpKey(addonId, key), value);
}

/**
 * Scans world dynamic property IDs to discover all dimension IDs that have persisted
 * config for this addon. Handles custom dimensions (namespaced like `mypack:dim`) by
 * matching known schema keys as suffixes rather than splitting on `:`.
 */
export function loadedDimensionIds(addonId: string, schema: FlatSchema): string[] {
  const prefix = `bc-cfg:d:${addonId}:`;
  const schemaKeys = Object.keys(schema);
  const dimIds = new Set<string>();

  for (const dpKey of world.getDynamicPropertyIds()) {
    if (!dpKey.startsWith(prefix)) { continue; }

    const rest = dpKey.slice(prefix.length);

    for (const schemaKey of schemaKeys) {
      const suffix = `:${schemaKey}`;

      if (rest.endsWith(suffix)) {
        dimIds.add(rest.slice(0, rest.length - suffix.length));
        break;
      }
    }
  }

  return [...dimIds];
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/** Drop Vector3 values — config only stores primitives or serialized JSON strings. */
function toPrimitive(
  raw: string | number | boolean | { x: number } | undefined,
): string | number | boolean | undefined {
  if (raw === undefined || typeof raw === 'object') { return undefined; }

  return raw;
}

function coerce(
  raw: string | number | boolean,
  entry: SerializedEntry,
): ConfigValue {
  if (entry.type === 'boolean') { return typeof raw === 'boolean' ? raw : raw === 'true'; }

  if (entry.type === 'number') { return typeof raw === 'number' ? raw : Number(raw); }

  return typeof raw === 'string' ? raw : String(raw);
}
