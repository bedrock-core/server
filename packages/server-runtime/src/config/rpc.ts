/**
 * RPC handlers auto-registered by ConfigRegistry.define().
 *
 * `patch` merges the provided keys; `set` replaces the whole scope — every schema key
 * missing from the payload reverts to its schema default (persisted override deleted).
 *
 * Methods:
 *   bc:config.patch              { [key]: value }                  → merge server values
 *   bc:config.set                { [key]: value }                  → replace server values
 *   bc:config.patch-dim          { dimId, values: { [key]: v } }   → merge per-dimension values
 *   bc:config.set-dim            { dimId, values: { [key]: v } }   → replace per-dimension values
 *   bc:config.get-player         { playerId }                      → get all effective player values
 *   bc:config.patch-player       { playerId, values: { [k]: v } }  → merge player values
 *   bc:config.set-player         { playerId, values: { [k]: v } }  → replace player values
 */
import type { Rpc, RPCHandlerMap } from '@bedrock-core/sync';
import type { ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

interface ConfigRpcInterface {
  'bc:config.patch': (params: Flat) => void;
  'bc:config.set': (params: Flat) => void;
  'bc:config.patch-dim': (params: { dimId: string; values: Flat }) => void;
  'bc:config.set-dim': (params: { dimId: string; values: Flat }) => void;
  'bc:config.get-player': (params: { playerId: string }) => Flat;
  'bc:config.patch-player': (params: { playerId: string; values: Flat }) => void;
  'bc:config.set-player': (params: { playerId: string; values: Flat }) => void;
}

export interface ConfigRpcHandlers {
  onPatchServer(flat: Flat): void;
  onSetServer(flat: Flat): void;
  onPatchDimension(dimId: string, flat: Flat): void;
  onSetDimension(dimId: string, flat: Flat): void;
  onGetPlayer(playerId: string): Flat;
  onPatchPlayer(playerId: string, flat: Flat): void;
  onSetPlayer(playerId: string, flat: Flat): void;
}

export function registerConfigRpc(rpc: Rpc, handlers: ConfigRpcHandlers): void {
  const map: RPCHandlerMap<ConfigRpcInterface> = {
    'bc:config.patch': (params) => { handlers.onPatchServer(params); },
    'bc:config.set': (params) => { handlers.onSetServer(params); },
    'bc:config.patch-dim': ({ dimId, values }) => { handlers.onPatchDimension(dimId, values); },
    'bc:config.set-dim': ({ dimId, values }) => { handlers.onSetDimension(dimId, values); },
    'bc:config.get-player': ({ playerId }) => handlers.onGetPlayer(playerId),
    'bc:config.patch-player': ({ playerId, values }) => { handlers.onPatchPlayer(playerId, values); },
    'bc:config.set-player': ({ playerId, values }) => { handlers.onSetPlayer(playerId, values); },
  };

  rpc.serve(map);
}
