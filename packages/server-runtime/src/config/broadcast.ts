/**
 * Config discovery over the sync state layer.
 *
 * Only the schema is pushed — two small, static maps per addon:
 *   'core-config/schema' → FlatSchema, scope-prefixed keys (`server.` / `dimension.` / `player.`)
 *   'core-config/groups' → FlatGroups, the display strings of the groups those keys nest under
 *
 * Its presence is the "this addon has config" signal (drives `core.config.of()` /
 * `subscribe()` and UI listings), and it lets a UI build forms without a round trip.
 * Values are NOT broadcast — they are fetched on demand via the `core:config.get-*` /
 * patch / set RPCs (see `rpc.ts`), which keeps steady-state traffic at zero and avoids
 * serving stale values for addons that have gone offline.
 */
import { stateKey } from '@bedrock-core/sync';
import type { State } from '@bedrock-core/sync';
import type { FlatGroups, FlatSchema } from './schema';

export const CONFIG_SCHEMA_KEY = stateKey<FlatSchema>('core-config/schema');

/**
 * Group display strings, on their own key rather than folded into the schema map.
 *
 * Additive on purpose: `core-config/schema` stays exactly the shape every existing consumer
 * reads, and one that never learned about groups is unaffected. A UI that does read this and
 * finds nothing — an addon on an older runtime, or one that names no group — falls back to the
 * key-derived titles it always used.
 */
export const CONFIG_GROUPS_KEY = stateKey<FlatGroups>('core-config/groups');

/** Publish the schema with `server.`/`dimension.`/`player.` prefixes on every key. */
export function broadcastSchema(
  state: State,
  addonId: string,
  serverFlat: FlatSchema,
  dimensionFlat: FlatSchema,
  playerFlat: FlatSchema,
): void {
  const scoped: FlatSchema = {};

  for (const [k, v] of Object.entries(serverFlat)) { scoped[`server.${k}`] = v; }

  for (const [k, v] of Object.entries(dimensionFlat)) { scoped[`dimension.${k}`] = v; }

  for (const [k, v] of Object.entries(playerFlat)) { scoped[`player.${k}`] = v; }

  state.set(addonId, CONFIG_SCHEMA_KEY, scoped);
}

/** Publish group display strings under the same `server.`/`dimension.`/`player.` prefixes. */
export function broadcastGroups(
  state: State,
  addonId: string,
  serverGroups: FlatGroups,
  dimensionGroups: FlatGroups,
  playerGroups: FlatGroups,
): void {
  const scoped: FlatGroups = {};

  for (const [k, v] of Object.entries(serverGroups)) { scoped[`server.${k}`] = v; }

  for (const [k, v] of Object.entries(dimensionGroups)) { scoped[`dimension.${k}`] = v; }

  for (const [k, v] of Object.entries(playerGroups)) { scoped[`player.${k}`] = v; }

  state.set(addonId, CONFIG_GROUPS_KEY, scoped);
}
