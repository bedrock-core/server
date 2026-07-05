/**
 * RPC handlers auto-registered by ConfigRegistry.define().
 *
 * Methods:
 *   bc:config.patch              { [key]: value }                 → patch server values
 *   bc:config.patch-dim          { dimId, values: { [key]: v } } → patch per-dimension values
 *   bc:config.patch-dim-default  { [key]: value }                 → patch dimension defaults
 *   bc:config.get-player         { playerId }                     → get all effective player values
 *   bc:config.patch-player       { playerId, values: { [k]: v } }→ patch player values
 *   bc:config.patch-player-default { [key]: value }               → patch player defaults
 */
import type { Rpc, RPCHandlerMap } from '@bedrock-core/sync';
import type { ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

interface ConfigRpcInterface {
  'bc:config.patch': (params: Flat) => void;
  'bc:config.patch-dim': (params: { dimId: string; values: Flat }) => void;
  'bc:config.patch-dim-default': (params: Flat) => void;
  'bc:config.get-player': (params: { playerId: string }) => Flat;
  'bc:config.patch-player': (params: { playerId: string; values: Flat }) => void;
  'bc:config.patch-player-default': (params: Flat) => void;
}

export interface ConfigRpcHandlers {
  onPatchServer(flat: Flat): void;
  onPatchDimension(dimId: string, flat: Flat): void;
  onPatchDimDefault(flat: Flat): void;
  onGetPlayer(playerId: string): Flat;
  onPatchPlayer(playerId: string, flat: Flat): void;
  onPatchPlayerDefault(flat: Flat): void;
}

export function registerConfigRpc(rpc: Rpc, handlers: ConfigRpcHandlers): void {
  const map: RPCHandlerMap<ConfigRpcInterface> = {
    'bc:config.patch': (params) => { handlers.onPatchServer(params); },
    'bc:config.patch-dim': ({ dimId, values }) => { handlers.onPatchDimension(dimId, values); },
    'bc:config.patch-dim-default': (params) => { handlers.onPatchDimDefault(params); },
    'bc:config.get-player': ({ playerId }) => handlers.onGetPlayer(playerId),
    'bc:config.patch-player': ({ playerId, values }) => { handlers.onPatchPlayer(playerId, values); },
    'bc:config.patch-player-default': (params) => { handlers.onPatchPlayerDefault(params); },
  };

  rpc.serve(map);
}
