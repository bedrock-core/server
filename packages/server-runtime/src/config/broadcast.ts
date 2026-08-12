/**
 * Config discovery over the sync state layer.
 *
 * Only the schema is pushed — one small, static map per addon:
 *   'core-config/schema' → FlatSchema, scope-prefixed keys (`server.` / `dimension.` / `player.`)
 *
 * Its presence is the "this addon has config" signal (drives `core.config.of()` /
 * `subscribe()` and UI listings), and it lets a UI build forms without a round trip.
 * Values are NOT broadcast — they are fetched on demand via the `bc:config.get-*` /
 * patch / set RPCs (see `rpc.ts`), which keeps steady-state traffic at zero and avoids
 * serving stale values for addons that have gone offline.
 */
import { stateKey } from '@bedrock-core/sync';
import type { State } from '@bedrock-core/sync';
import type { FlatSchema } from './schema';

export const BC_CONFIG_SCHEMA = stateKey<FlatSchema>('core-config/schema');

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
