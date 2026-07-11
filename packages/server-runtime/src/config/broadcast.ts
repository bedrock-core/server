/**
 * Broadcast config schema and values to the sync state layer so other addons
 * (and the UI) can discover them.
 *
 * State keys (all under the owning addon's namespace):
 *   'bc-config/schema'              → FlatSchema (all scopes combined)
 *   'bc-config/server'              → Record<string, ConfigValue>
 *   'bc-config/dim/<dimId>'         → Record<string, ConfigValue> (effective values)
 *   'bc-config/dim'                 → Record<string, ConfigValue>
 *   'bc-config/player/<playerId>'   → Record<string, ConfigValue> (effective, online only)
 *   'bc-config/player'              → Record<string, ConfigValue>
 */
import { stateKey } from '@bedrock-core/sync';
import type { State, StateKey } from '@bedrock-core/sync';
import type { FlatSchema, ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

export const BC_CONFIG_SCHEMA = stateKey<FlatSchema>('bc-config/schema');
export const BC_CONFIG_SCOPED_SCHEMA = stateKey<FlatSchema>('bc-config/schema-s');
export const BC_CONFIG_SERVER = stateKey<Flat>('bc-config/server');
export const BC_CONFIG_DIM_DEFAULTS = stateKey<Flat>('bc-config/dim');
export const BC_CONFIG_PLAYER_DEFAULTS = stateKey<Flat>('bc-config/player');

/** Effective per-dimension values for one dimension. */
export const dimValuesKey = (dimId: string): StateKey<Flat> => stateKey(`bc-config/dim/${dimId}`);

/** Effective per-player values for one online player. */
export const playerValuesKey = (playerId: string): StateKey<Flat> => stateKey(`bc-config/player/${playerId}`);

export function broadcastSchema(state: State, addonId: string, schema: FlatSchema): void {
  state.set(addonId, BC_CONFIG_SCHEMA, schema);
}

export function broadcastScopedSchema(
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

  state.set(addonId, BC_CONFIG_SCOPED_SCHEMA, scoped);
}

export function broadcastServerValues(
  state: State,
  addonId: string,
  values: Map<string, ConfigValue>,
): void {
  state.set(addonId, BC_CONFIG_SERVER, Object.fromEntries(values));
}

export function broadcastDimensionValues(
  state: State,
  addonId: string,
  dimId: string,
  values: Map<string, ConfigValue>,
): void {
  state.set(addonId, dimValuesKey(dimId), Object.fromEntries(values));
}

export function broadcastDimensionDefaults(
  state: State,
  addonId: string,
  defaults: Map<string, ConfigValue>,
): void {
  state.set(addonId, BC_CONFIG_DIM_DEFAULTS, Object.fromEntries(defaults));
}

export function broadcastPlayerValues(
  state: State,
  addonId: string,
  playerId: string,
  values: Map<string, ConfigValue>,
): void {
  state.set(addonId, playerValuesKey(playerId), Object.fromEntries(values));
}

export function broadcastPlayerDefaults(
  state: State,
  addonId: string,
  defaults: Map<string, ConfigValue>,
): void {
  state.set(addonId, BC_CONFIG_PLAYER_DEFAULTS, Object.fromEntries(defaults));
}
