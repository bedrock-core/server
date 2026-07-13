/**
 * Broadcast config schema and values to the sync state layer so other addons
 * (and the UI) can discover them.
 *
 * State keys (all under the owning addon's namespace):
 *   'bc-config/schema'              → FlatSchema, scope-prefixed keys (`server.` / `dimension.` / `player.`)
 *   'bc-config/server'              → Record<string, ConfigValue>
 *   'bc-config/dim/<dimId>'         → Record<string, ConfigValue> (effective values)
 *   'bc-config/player/<playerId>'   → Record<string, ConfigValue> (effective, online only)
 *
 * The schema is published once, in scoped form only; the unprefixed flat view is derived
 * on read (see `RemoteConfigAccessor.schema`) instead of shipping the map twice.
 */
import { stateKey } from '@bedrock-core/sync';
import type { State, StateKey } from '@bedrock-core/sync';
import type { FlatSchema, ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

export const BC_CONFIG_SCHEMA = stateKey<FlatSchema>('bc-config/schema');
export const BC_CONFIG_SERVER = stateKey<Flat>('bc-config/server');

/** Effective per-dimension values for one dimension. */
export const dimValuesKey = (dimId: string): StateKey<Flat> => stateKey(`bc-config/dim/${dimId}`);

/** Effective per-player values for one online player. */
export const playerValuesKey = (playerId: string): StateKey<Flat> => stateKey(`bc-config/player/${playerId}`);

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

  state.set(addonId, BC_CONFIG_SCHEMA, scoped);
}

export function broadcastServerValues(
  state: State,
  addonId: string,
  values: Map<string, ConfigValue>,
): void {
  state.set(addonId, BC_CONFIG_SERVER, Object.fromEntries(values));
}
