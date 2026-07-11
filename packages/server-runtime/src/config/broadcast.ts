/**
 * Broadcast config schema and values to the sync state layer so other addons
 * (and the UI) can discover them.
 *
 * State keys (all under the owning addon's namespace):
 *   'bc-config/schema'              → FlatSchema (all scopes combined)
 *   'bc-config/server'              → Record<string, ConfigValue>
 *   'bc-config/dim/<dimId>'         → Record<string, ConfigValue> (effective values)
 *   'bc-config/dims'                → RosterEntry[] (known dimension ids, for UI pickers)
 *   'bc-config/player/<playerId>'   → Record<string, ConfigValue> (effective, online only)
 *   'bc-config/players'             → RosterEntry[] (online players, for UI pickers)
 */
import { stateKey } from '@bedrock-core/sync';
import type { State, StateKey } from '@bedrock-core/sync';
import type { FlatSchema, ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

/** One selectable entity for a UI picker list. */
export interface RosterEntry {
  id: string;
  name: string;
}

export const BC_CONFIG_SCHEMA = stateKey<FlatSchema>('bc-config/schema');
export const BC_CONFIG_SCOPED_SCHEMA = stateKey<FlatSchema>('bc-config/schema-s');
export const BC_CONFIG_SERVER = stateKey<Flat>('bc-config/server');
export const BC_CONFIG_DIMENSIONS = stateKey<RosterEntry[]>('bc-config/dims');
export const BC_CONFIG_PLAYERS = stateKey<RosterEntry[]>('bc-config/players');

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

export function broadcastPlayerValues(
  state: State,
  addonId: string,
  playerId: string,
  values: Map<string, ConfigValue>,
): void {
  state.set(addonId, playerValuesKey(playerId), Object.fromEntries(values));
}

export function broadcastDimensionRoster(state: State, addonId: string, dims: RosterEntry[]): void {
  state.set(addonId, BC_CONFIG_DIMENSIONS, dims);
}

export function broadcastPlayerRoster(state: State, addonId: string, players: RosterEntry[]): void {
  state.set(addonId, BC_CONFIG_PLAYERS, players);
}
