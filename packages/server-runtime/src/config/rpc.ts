/**
 * RPC handlers auto-registered by ConfigRegistry.define().
 *
 * Values are not broadcast — consumers fetch them on demand with the `get-*` methods.
 * `patch` merges the provided keys; `set` replaces the whole scope — every schema key
 * missing from the payload reverts to its schema default (persisted override deleted).
 * Every write resolves with the updated effective flat map, so callers get
 * read-after-write in one round trip.
 *
 * Methods (all return the scope's effective flat values):
 *   bc:config.get-server         {}                                → read server values
 *   bc:config.patch              { [key]: value }                  → merge server values
 *   bc:config.set                { [key]: value }                  → replace server values
 *   bc:config.get-dim            { dimId }                         → read per-dimension values
 *   bc:config.patch-dim          { dimId, values: { [key]: v } }   → merge per-dimension values
 *   bc:config.set-dim            { dimId, values: { [key]: v } }   → replace per-dimension values
 *   bc:config.get-player         { playerId }                      → read player values
 *   bc:config.patch-player       { playerId, values: { [k]: v } }  → merge player values
 *   bc:config.set-player         { playerId, values: { [k]: v } }  → replace player values
 */
import type { Rpc, RPCHandlerMap } from '@bedrock-core/sync';
import type { ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

interface ConfigRpcInterface {
  'bc:config.get-server': (params: Record<string, never>) => Flat;
  'bc:config.patch': (params: Flat) => Flat;
  'bc:config.set': (params: Flat) => Flat;
  'bc:config.get-dim': (params: { dimId: string }) => Flat;
  'bc:config.patch-dim': (params: { dimId: string; values: Flat }) => Flat;
  'bc:config.set-dim': (params: { dimId: string; values: Flat }) => Flat;
  'bc:config.get-player': (params: { playerId: string }) => Flat;
  'bc:config.patch-player': (params: { playerId: string; values: Flat }) => Flat;
  'bc:config.set-player': (params: { playerId: string; values: Flat }) => Flat;
}

export interface ConfigRpcHandlers {
  onGetServer(): Flat;
  onPatchServer(flat: Flat): Flat;
  onSetServer(flat: Flat): Flat;
  onGetDimension(dimId: string): Flat;
  onPatchDimension(dimId: string, flat: Flat): Flat;
  onSetDimension(dimId: string, flat: Flat): Flat;
  onGetPlayer(playerId: string): Flat;
  onPatchPlayer(playerId: string, flat: Flat): Flat;
  onSetPlayer(playerId: string, flat: Flat): Flat;
}

export function registerConfigRpc(rpc: Rpc, handlers: ConfigRpcHandlers): void {
  const map: RPCHandlerMap<ConfigRpcInterface> = {
    'bc:config.get-server': () => handlers.onGetServer(),
    'bc:config.patch': params => handlers.onPatchServer(params),
    'bc:config.set': params => handlers.onSetServer(params),
    'bc:config.get-dim': ({ dimId }) => handlers.onGetDimension(dimId),
    'bc:config.patch-dim': ({ dimId, values }) => handlers.onPatchDimension(dimId, values),
    'bc:config.set-dim': ({ dimId, values }) => handlers.onSetDimension(dimId, values),
    'bc:config.get-player': ({ playerId }) => handlers.onGetPlayer(playerId),
    'bc:config.patch-player': ({ playerId, values }) => handlers.onPatchPlayer(playerId, values),
    'bc:config.set-player': ({ playerId, values }) => handlers.onSetPlayer(playerId, values),
  };

  rpc.serve(map);
}
