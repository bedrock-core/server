/**
 * Serves this addon's documents to peers.
 *
 * Registered once per runtime, whether or not the addon declares a collection: a request for a
 * collection that does not exist has to answer "no such collection" rather than time out, and a
 * peer cannot know which collections an addon declared until it asks.
 */
import type { Db, IndexedDocument, TargetKind } from '@bedrock-core/db';
import type { Rpc } from '@bedrock-core/sync';
import { denyReason } from './authorization';
import { registerDbRpc, type WireResult } from './rpc';

export class DbRequests {
  private readonly _db: Db;
  private readonly _addonId: string;

  constructor(db: Db, addonId: string) {
    this._db = db;
    this._addonId = addonId;
  }

  start(rpc: Rpc): void {
    registerDbRpc(rpc, {
      onGet: (collection, kind, identity, actorId) => this._read(collection, kind, identity, actorId),

      onPatch: (collection, kind, identity, changes, actorId) => this._write(
        collection,
        kind,
        identity,
        actorId,
        doc => doc.patch(changes),
      ),

      onSet: (collection, kind, identity, doc, actorId) => this._write(
        collection,
        kind,
        identity,
        actorId,
        handle => handle.set(doc),
      ),
    });
  }

  /**
   * Reads are authorized too: one player's document is not another player's business, the same
   * rule config applies to its player scope.
   */
  private _read(collection: string, kind: TargetKind, identity: string, actorId?: string): WireResult {
    this._authorize(kind, identity, actorId);

    return this._at(collection, kind, identity).get() ?? null;
  }

  private _write(
    collection: string,
    kind: TargetKind,
    identity: string,
    actorId: string | undefined,
    apply: (doc: IndexedDocument<object>) => void,
  ): WireResult {
    this._authorize(kind, identity, actorId);

    const handle = this._at(collection, kind, identity);

    apply(handle);

    // Read-after-write in one round trip, so a caller never has to follow with a get.
    return handle.get() ?? null;
  }

  private _authorize(kind: TargetKind, identity: string, actorId: string | undefined): void {
    const denied = denyReason(kind, identity, actorId);

    if (denied !== undefined) {
      throw new Error(`[${this._addonId}] db: ${denied}`);
    }
  }

  /**
   * The handle for one addressed document.
   *
   * Throws rather than answering `null` when there is no such collection or no such entry: a peer
   * asking for something that does not exist has a bug, and an empty document reads the same as a
   * misspelled collection name otherwise.
   */
  private _at(collection: string, kind: TargetKind, identity: string): IndexedDocument<object> {
    const found = this._db.find(collection);

    if (found === undefined) {
      throw new Error(`[${this._addonId}] db: no collection named '${collection}'`);
    }

    const handle = found.at(kind, identity);

    if (handle === undefined) {
      throw new Error(`[${this._addonId}] db: '${collection}' has no ${kind} document for '${identity}'`);
    }

    return handle;
  }
}
