/**
 * Replicated key/value state — the shared channel.
 *
 * Model (chosen with the user): **shared-mutable runtime.** Any node may read or write any
 * `namespace:key`. Writes broadcast a `state-delta` and every node applies it to its
 * in-memory mirror, so reads are always local — no round-trip. Conflicts resolve
 * last-write-wins on a Lamport-style logical clock, tie-broken by the writer's id, so all
 * mirrors converge regardless of delivery order.
 *
 * Persistence is **not** sync's job: an addon that wants durability subscribes via
 * {@link State.subscribe}, writes its own namespace to its own dynamic properties, and
 * re-publishes (via {@link State.set}) on load. Deletions are tombstones so a late-arriving
 * older write can't resurrect a removed key.
 */
import { MessageType } from './constants';
import type { Bus } from './bus';
import type { Envelope } from './envelope';
import type { Unsubscribe } from './bus';

declare const stateValueBrand: unique symbol;

/**
 * A state key that carries the type of the value stored under it. Purely a compile-time
 * assertion — like any state read, the actual value comes from whichever peer wrote it
 * last and is not validated at runtime. Create with {@link stateKey}.
 */
export type StateKey<T> = string & { readonly [stateValueBrand]?: T };

/** Brand a key string with its value type, for typed `state.get`/`state.set` calls. */
export function stateKey<T>(key: string): StateKey<T> {
  return key;
}

interface Entry {
  value?: unknown;
  ver: number;
  src: string;
  del?: boolean;
  /** The owner declared this key writable by any node. Only the owner's own entries set it. */
  open?: boolean;
}

/** A serializable snapshot of one entry. */
export interface SnapshotEntry {
  k: string;
  v?: unknown;
  ver: number;
  src: string;
  del?: boolean;
  o?: boolean;
}

interface DeltaData {
  ns: string;
  key: string;
  value?: unknown;
  ver: number;
  del?: boolean;
  open?: boolean;
}

export interface SetOptions {
  /**
   * Any node may write this key from now on. Without it a mirror applies writes to a namespace
   * only from the namespace's owner — the node whose id is the namespace — and drops the rest.
   */
  open?: boolean;
}

interface SnapshotData {
  ns: string;
  entries: SnapshotEntry[];
}

function isDeltaData(value: unknown): value is DeltaData {
  if (typeof value !== 'object' || value === null) { return false; }

  if (!('ns' in value && 'key' in value && 'ver' in value)) { return false; }

  const { ns, key, ver } = value;

  return typeof ns === 'string' && typeof key === 'string' && typeof ver === 'number';
}

/** A state request carries an optional namespace filter — `{}` means "everything". */
function requestedNamespace(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('ns' in value)) { return undefined; }

  const { ns } = value;

  return typeof ns === 'string' ? ns : undefined;
}

function isSnapshotData(value: unknown): value is SnapshotData {
  if (typeof value !== 'object' || value === null) { return false; }

  if (!('ns' in value && 'entries' in value)) { return false; }

  const { ns, entries } = value;

  return typeof ns === 'string' && Array.isArray(entries);
}

export interface StateChange {
  ns: string;
  key: string;

  /** The new value, or `undefined` when the key was deleted. */
  value: unknown | undefined;
  deleted: boolean;
}

export type StateChangeListener = (change: StateChange) => void;

export interface StateOptions {

  /** Namespaces this node is authoritative for (answers snapshot requests for them). */
  ownedNamespaces?: string[];

  /**
   * When `true`, `set()` and `delete()` are restricted to owned namespaces. Any attempt to
   * write a namespace not in `ownedNamespaces` throws. Defaults to `false` (shared-mutable).
   */
  strictOwnership?: boolean;
}

export class State {
  private readonly _bus: Bus;
  private readonly _selfId: string;
  private readonly _owned: Set<string>;
  private readonly _strictOwnership: boolean;
  private readonly _store = new Map<string, Map<string, Entry>>();
  private readonly _changeListeners = new Set<StateChangeListener>();
  private readonly _disposers: Unsubscribe[] = [];
  private _clock = 0;
  private _droppedForeign = 0;

  constructor(bus: Bus, selfId: string, options: StateOptions = {}) {
    this._bus = bus;
    this._selfId = selfId;
    this._owned = new Set(options.ownedNamespaces ?? [selfId]);
    this._strictOwnership = options.strictOwnership ?? false;
  }

  /** Register handlers and pull existing state from peers (late-join sync). */
  start(): void {
    this._disposers.push(
      this._bus.on(MessageType.StateDelta, env => this.handleDelta(env)),
      this._bus.on(MessageType.StateRequest, env => this.handleStateRequest(env)),
      this._bus.on(MessageType.StateSnapshot, env => this.handleSnapshot(env)),
    );

    this.requestSync();
    this.broadcastOwnedSnapshots();
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }
  }

  /** Read a key from the local mirror. Returns `undefined` if absent or deleted. */
  get<T = unknown>(ns: string, key: StateKey<T>): NoInfer<T> | undefined;
  get(ns: string, key: string): unknown | undefined {
    const entry = this._store.get(ns)?.get(key);

    return entry && !entry.del ? entry.value : undefined;
  }

  /** Read every live key in a namespace as a plain object. */
  getNamespace(ns: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const map = this._store.get(ns);

    if (!map) { return result; }

    for (const [key, entry] of map) {
      if (!entry.del) { result[key] = entry.value; }
    }

    return result;
  }

  /** Namespaces currently present in the mirror. */
  namespaces(): string[] {
    return Array.from(this._store.keys());
  }

  /** Whether the owner of `ns` has declared `key` writable by any node. */
  isOpen(ns: string, key: string): boolean {
    return this._store.get(ns)?.get(key)?.open === true;
  }

  /** How many writes from a node other than the namespace's owner this mirror has refused. */
  get droppedForeign(): number {
    return this._droppedForeign;
  }

  /**
   * Write a key. Broadcasts a delta. Throws if `strictOwnership` is enabled and `ns` is not owned.
   * A write to a namespace this node does not own reaches the mirrors only if the owner marked the
   * key `open`; the local mirror applies the same rule, so the write is visible here exactly when
   * it is visible everywhere.
   */
  set<T = unknown>(ns: string, key: StateKey<T>, value: NoInfer<T>, options?: SetOptions): void;
  set(ns: string, key: string, value: unknown, options?: SetOptions): void {
    this.assertWritable(ns);

    const open = this._owned.has(ns) && options?.open === true ? true : undefined;
    const entry: Entry = { value, ver: ++this._clock, src: this._selfId, open };

    this.applyEntry(ns, key, entry, this._owned.has(ns));
    this._bus.send({ type: MessageType.StateDelta, data: { ns, key, value, ver: entry.ver, open } });
  }

  /** Delete a key (tombstone). Broadcasts a delta. Throws if `strictOwnership` is enabled and `ns` is not owned. */
  delete(ns: string, key: string): void {
    this.assertWritable(ns);

    const entry: Entry = { ver: ++this._clock, src: this._selfId, del: true };

    this.applyEntry(ns, key, entry, this._owned.has(ns));
    this._bus.send({ type: MessageType.StateDelta, data: { ns, key, ver: entry.ver, del: true } });
  }

  /** Broadcast a request for peers to send their state (optionally a single namespace). */
  requestSync(ns?: string): void {
    this._bus.send({ type: MessageType.StateRequest, data: ns ? { ns } : {} });
  }

  /** Notified on every applied change (local or remote). Returns an unsubscribe function. */
  subscribe(listener: StateChangeListener): Unsubscribe {
    this._changeListeners.add(listener);

    return (): void => {
      this._changeListeners.delete(listener);
    };
  }

  /** Serialize a namespace (includes tombstones) — used to answer snapshot requests. */
  snapshot(ns: string): SnapshotEntry[] {
    const map = this._store.get(ns);

    if (!map) { return []; }

    return Array.from(map, ([k, entry]) => ({
      k,
      v: entry.value,
      ver: entry.ver,
      src: entry.src,
      del: entry.del,
      o: entry.open,
    }));
  }

  /** Broadcast a full snapshot of every owned namespace (used at startup). */
  broadcastOwnedSnapshots(): void {
    for (const ns of this._owned) {
      const entries = this.snapshot(ns);

      if (entries.length > 0) {
        this._bus.send({ type: MessageType.StateSnapshot, data: { ns, entries } });
      }
    }
  }

  private assertWritable(ns: string): void {
    if (this._strictOwnership && !this._owned.has(ns)) {
      throw new Error(`[sync] cannot write to namespace '${ns}': not owned by this node (strictOwnership is enabled)`);
    }
  }

  private handleDelta(envelope: Envelope): void {
    if (!isDeltaData(envelope.data)) { return; }

    const { ns, key, ver, value, del, open } = envelope.data;

    this._clock = Math.max(this._clock, ver);
    this.applyEntry(ns, key, { value, ver, src: envelope.src, del, open: open === true ? true : undefined }, envelope.src === ns);
  }

  private handleStateRequest(envelope: Envelope): void {
    const requested = requestedNamespace(envelope.data);

    for (const ns of this._owned) {
      if (requested !== undefined && requested !== ns) { continue; }

      const entries = this.snapshot(ns);

      if (entries.length > 0) {
        this._bus.send({ dst: envelope.src, type: MessageType.StateSnapshot, data: { ns, entries } });
      }
    }
  }

  private handleSnapshot(envelope: Envelope): void {
    if (!isSnapshotData(envelope.data)) { return; }

    const { ns, entries } = envelope.data;

    for (const entry of entries) {
      this._clock = Math.max(this._clock, entry.ver);
      this.applyEntry(ns, entry.k, { value: entry.v, ver: entry.ver, src: entry.src, del: entry.del, open: entry.o === true ? true : undefined }, entry.src === ns);
    }
  }

  /**
   * Apply an entry under last-write-wins. The owner of a namespace — the node whose id it is —
   * is the only writer a mirror trusts, unless the owner marked the key `open`; a foreign write
   * to any other key is dropped, and a foreign write never changes the `open` flag. Returns
   * whether the entry won.
   */
  private applyEntry(ns: string, key: string, incoming: Entry, fromOwner: boolean): boolean {
    let map = this._store.get(ns);

    if (!map) {
      map = new Map();
      this._store.set(ns, map);
    }

    const current = map.get(key);

    if (!fromOwner) {
      if (current?.open !== true) {
        this._droppedForeign++;

        return false;
      }

      incoming.open = true;
    }

    if (current && !this.isNewer(incoming, current)) { return false; }

    map.set(key, incoming);
    this.emitChange({
      ns,
      key,
      value: incoming.del ? undefined : incoming.value,
      deleted: incoming.del === true,
    });

    return true;
  }

  private isNewer(incoming: Entry, current: Entry): boolean {
    if (incoming.ver !== current.ver) { return incoming.ver > current.ver; }

    return incoming.src > current.src;
  }

  private emitChange(change: StateChange): void {
    for (const listener of this._changeListeners) { listener(change); }
  }
}
