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
import type { State } from '@bedrock-core/sync';
import type { FlatSchema, ConfigValue } from './schema';

export const BC_CONFIG_SCHEMA = 'bc-config/schema';
export const BC_CONFIG_SCOPED_SCHEMA = 'bc-config/schema-s';
export const BC_CONFIG_SERVER = 'bc-config/server';
export const BC_CONFIG_DIM_PREFIX = 'bc-config/dim/';
export const BC_CONFIG_DIM_DEFAULTS = 'bc-config/dim';
export const BC_CONFIG_PLAYER_VALUES_PREFIX = 'bc-config/player/';
export const BC_CONFIG_PLAYER_DEFAULTS = 'bc-config/player';

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
  state.set(addonId, `${BC_CONFIG_DIM_PREFIX}${dimId}`, Object.fromEntries(values));
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
  state.set(addonId, `${BC_CONFIG_PLAYER_VALUES_PREFIX}${playerId}`, Object.fromEntries(values));
}

export function broadcastPlayerDefaults(
  state: State,
  addonId: string,
  defaults: Map<string, ConfigValue>,
): void {
  state.set(addonId, BC_CONFIG_PLAYER_DEFAULTS, Object.fromEntries(defaults));
}
