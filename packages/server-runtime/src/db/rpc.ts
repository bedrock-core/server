/**
 * RPC over another addon's documents, registered by the runtime for every addon.
 *
 * A peer reads a document through `core.query`, which resolves warm from the shared mirror when the
 * collection is `shared` and falls back to `core:db.get` when it is not. Writes are always this
 * RPC: **the mirror never writes back into a document**, so a peer that wants a change asks the
 * owner, and the owner applies it under its own rules.
 *
 * A document is addressed the way the index keeps it — collection name, target kind, identity —
 * because a `Block` or an `Entity` cannot travel over the wire.
 *
 * Every request may carry an `actorId`: the player it is made on behalf of, checked with
 * `denyReason`. Absent means an addon acting for itself, which is unrestricted; see
 * `authorization.ts`.
 *
 * Methods:
 *   core:db.get     { collection, kind, identity, actorId? }          → the document, or null
 *   core:db.patch   { collection, kind, identity, changes, actorId? } → the document after merging
 *   core:db.set     { collection, kind, identity, doc, actorId? }     → the document after replacing
 */
import type { TargetKind } from '@bedrock-core/db';
import type { Rpc, RPCHandlerMap } from '@bedrock-core/sync';

/** A document as it travels: whatever the owner's schema says, opaque to the caller and to us. */
export type WireDocument = Record<string, unknown>;

/**
 * What comes back: the owner's document, opaque here because its shape is the owner's schema.
 * `null` rather than `undefined`, so an absent document survives JSON.
 */
export type WireResult = object | null;

interface DbRpcInterface {
  'core:db.get': (params: { collection: string; kind: TargetKind; identity: string; actorId?: string }) => WireResult;
  'core:db.patch': (params: { collection: string; kind: TargetKind; identity: string; changes: WireDocument; actorId?: string }) => WireResult;
  'core:db.set': (params: { collection: string; kind: TargetKind; identity: string; doc: WireDocument; actorId?: string }) => WireResult;
}

export interface DbRpcHandlers {
  onGet(collection: string, kind: TargetKind, identity: string, actorId?: string): WireResult;
  onPatch(collection: string, kind: TargetKind, identity: string, changes: WireDocument, actorId?: string): WireResult;
  onSet(collection: string, kind: TargetKind, identity: string, doc: WireDocument, actorId?: string): WireResult;
}

export function registerDbRpc(rpc: Rpc, handlers: DbRpcHandlers): void {
  const map: RPCHandlerMap<DbRpcInterface> = {
    'core:db.get': ({ collection, kind, identity, actorId }) => handlers.onGet(collection, kind, identity, actorId),
    'core:db.patch': ({ collection, kind, identity, changes, actorId }) => handlers.onPatch(collection, kind, identity, changes, actorId),
    'core:db.set': ({ collection, kind, identity, doc, actorId }) => handlers.onSet(collection, kind, identity, doc, actorId),
  };

  rpc.serve(map);
}
