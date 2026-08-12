/**
 * RPC handlers auto-registered by ConfigRegistry.define().
 *
 * Values are not broadcast — consumers fetch them on demand with the `get-*` methods.
 * `patch` merges the provided keys; `set` replaces the whole scope — every schema key
 * missing from the payload reverts to its schema default (persisted override deleted).
 * Every write resolves with the updated effective flat map, so callers get
 * read-after-write in one round trip.
 *
 * Every request may carry an `actorId`: the player it is made on behalf of, which the handlers
 * check via `denyReason`. Absent means an addon acting for itself, which is unrestricted — see
 * `authorization.ts`. Server-scope writes wrap their payload in `values` for exactly this
 * reason: with the flat map as the params, an `actorId` field would be indistinguishable from
 * a schema key of that name.
 *
 * Methods (all return the scope's effective flat values):
 *   core:config.get-server         {}                                     → read server values
 *   core:config.patch              { values, actorId? }                   → merge server values
 *   core:config.set                { values, actorId? }                   → replace server values
 *   core:config.get-dim            { dimId }                              → read per-dimension values
 *   core:config.patch-dim          { dimId, values, actorId? }            → merge per-dimension values
 *   core:config.set-dim            { dimId, values, actorId? }            → replace per-dimension values
 *   core:config.get-player         { playerId, actorId? }                 → read player values
 *   core:config.patch-player       { playerId, values, actorId? }         → merge player values
 *   core:config.set-player         { playerId, values, actorId? }         → replace player values
 */
import type { Rpc, RPCHandlerMap } from '@bedrock-core/sync';
import type { ConfigValue } from './schema';

type Flat = Record<string, ConfigValue>;

interface ConfigRpcInterface {
  'core:config.get-server': (params: Record<string, never>) => Flat;
  'core:config.patch': (params: { values: Flat; actorId?: string }) => Flat;
  'core:config.set': (params: { values: Flat; actorId?: string }) => Flat;
  'core:config.get-dim': (params: { dimId: string }) => Flat;
  'core:config.patch-dim': (params: { dimId: string; values: Flat; actorId?: string }) => Flat;
  'core:config.set-dim': (params: { dimId: string; values: Flat; actorId?: string }) => Flat;
  'core:config.get-player': (params: { playerId: string; actorId?: string }) => Flat;
  'core:config.patch-player': (params: { playerId: string; values: Flat; actorId?: string }) => Flat;
  'core:config.set-player': (params: { playerId: string; values: Flat; actorId?: string }) => Flat;
}

/**
 * `actorId` is the player a request is made on behalf of, or `undefined` for a programmatic
 * addon-to-addon call. Handlers are expected to refuse when `denyReason` says so.
 */
export interface ConfigRpcHandlers {
  onGetServer(): Flat;
  onPatchServer(flat: Flat, actorId?: string): Flat;
  onSetServer(flat: Flat, actorId?: string): Flat;
  onGetDimension(dimId: string): Flat;
  onPatchDimension(dimId: string, flat: Flat, actorId?: string): Flat;
  onSetDimension(dimId: string, flat: Flat, actorId?: string): Flat;
  onGetPlayer(playerId: string, actorId?: string): Flat;
  onPatchPlayer(playerId: string, flat: Flat, actorId?: string): Flat;
  onSetPlayer(playerId: string, flat: Flat, actorId?: string): Flat;
}

export function registerConfigRpc(rpc: Rpc, handlers: ConfigRpcHandlers): void {
  const map: RPCHandlerMap<ConfigRpcInterface> = {
    'core:config.get-server': () => handlers.onGetServer(),
    'core:config.patch': ({ values, actorId }) => handlers.onPatchServer(values, actorId),
    'core:config.set': ({ values, actorId }) => handlers.onSetServer(values, actorId),
    'core:config.get-dim': ({ dimId }) => handlers.onGetDimension(dimId),
    'core:config.patch-dim': ({ dimId, values, actorId }) => handlers.onPatchDimension(dimId, values, actorId),
    'core:config.set-dim': ({ dimId, values, actorId }) => handlers.onSetDimension(dimId, values, actorId),
    'core:config.get-player': ({ playerId, actorId }) => handlers.onGetPlayer(playerId, actorId),
    'core:config.patch-player': ({ playerId, values, actorId }) => handlers.onPatchPlayer(playerId, values, actorId),
    'core:config.set-player': ({ playerId, values, actorId }) => handlers.onSetPlayer(playerId, values, actorId),
  };

  rpc.serve(map);
}
