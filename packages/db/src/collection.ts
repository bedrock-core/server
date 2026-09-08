/**
 * A collection: typed documents keyed by target, stored wherever the target can hold bytes.
 *
 * `for(target)` keeps an identity and a way to find the target again, never the handle it was
 * given — a `Block` goes stale when its chunk unloads, an `Entity` after removal — and every
 * operation re-resolves, at most once per tick. Reads answer `undefined` when the target cannot be
 * reached; writes throw `DbTargetError` naming the collection, because writing to nothing is a bug
 * at the call site. A proxied document (world property keyed by identity) stays readable while its
 * target is unloaded, since the world needs no chunk.
 *
 * Write-through: a `set` or `patch` updates the in-memory document and the dynamic property in the
 * same call — measured at 17 µs there is nothing to flush and nothing to lose. Documents are cached
 * by identity once read; a container slot has no identity, so its documents are read each time and
 * never indexed.
 *
 * `all()` walks the collection's index — world properties listing the identities that hold a
 * document — and self-heals: a block found replaced by another type drops out of the index, and its
 * world-kept document with it.
 *
 * `coalesce: true` turns a collection write-behind: writes land in memory and one flush per tick
 * writes each dirty document once. It is offered only where a dirty document cannot die with its
 * target inside that window — on the world, and on entities, whose unloaded documents are parked
 * and written when the entity loads again (players are flushed as they leave instead).
 *
 * Handles and collections are classes with prototype methods: the engine runs QuickJS, where a
 * `for()` that allocated a dozen closures cost more than the property write it wrapped.
 */
import { observable, type Observable, type Unsubscribe } from '@bedrock-core/observable';
import { accepts, type Acceptor, type Conflicts, type Requirements, type StorableTarget } from './accept';
import { createDocumentStore, type DocumentSchema, type DocumentStore, type Schema } from './document';
import { DbBudgetError, DbTargetError } from './errors';
import { directHost, prefixed, type Capabilities, type DirectDp, type DpHost } from './host';
import { createIndexSet, type IndexSet } from './indexed';
import { createResolver, type Accepted, type Classifier, type Resolution, type Resolver, type TargetKind } from './resolve';

export interface CollectionOptions<T extends object, Target, R extends Requirements> {
  /** The document type, with its version, defaults and migrations: `schema<Elevator>({ version: 2 })`. */
  schema: Schema<T>;
  /** Which targets may carry a document. Anything the resolver can host when omitted. */
  accept?: Acceptor<Target>;
  /** What the host must offer; a target whose host lacks it is refused with a reason instead of silently stored elsewhere. */
  require?: R;
  /**
   * Write-behind: one dynamic-property write per dirty document per flush, for the counter bumped a
   * hundred times a tick. Refused with a reason on a block or slot, where the target can vanish
   * before the flush.
   */
  coalesce?: boolean;

  /**
   * What peers see of this collection through the shared mirror. Peers read it with `core.query`,
   * never `core.shared`, which is what gives them status, staleness and a refused write.
   *
   * - omitted — a **version stamp** per document. A peer's query for that key goes stale the same
   *   tick and refetches on its next read. Cheap: the announcement is a number whatever the
   *   document weighs.
   * - `true` — the **document itself**, so a peer's query resolves warm with no round trip.
   * - `{ as }` — a **derived subset**, for a large document whose peers only need part of it.
   *
   * Size is the thing to weigh: announcing is serialization on this addon's own tick, 380 µs at
   * 1 KB and 3.1 ms at 10 KB ([S6](../../../docs/spikes/S6-shared-bus-cost.md)). Delivery is not
   * the cost — a delta reaches four peers in the same tick — so prefer `{ as }` over `true` for
   * anything large. Announcements are coalesced to one per document per tick regardless.
   */
  shared?: boolean | { as(doc: T): unknown };
}

export interface Document<T extends object> {
  /** Whether the target can be reached and the collection accepts it right now. */
  readonly available: boolean;
  /** Why `available` is false, or `undefined`. */
  readonly reason: string | undefined;
  /** The document, `undefined` when there is none or the target cannot be reached. Treat it as immutable; change it with `patch`. */
  get(): T | undefined;
  set(doc: T): void;
  /** Merges over the current document, or over `defaults` when there is none. */
  patch(changes: Partial<T>): void;
  /** Removes the document. Never throws: a document whose target is gone is removed where it can be. */
  delete(): void;
  /** Local change events for this document; fires with the new document or `undefined` on delete. */
  subscribe(listener: (doc: T | undefined) => void): Unsubscribe;
}

/** A document reached through the index rather than a target the caller holds. */
export interface IndexedDocument<T extends object> extends Document<T> {
  readonly kind: TargetKind;
  /** The identity the index keeps: an entity id, `<dim>:<x>,<y>,<z>:<typeId>` for a block, a dimension id. */
  readonly identity: string;
}

export type Where
  = | { ok: true; kind: TargetKind; caps: Capabilities }
    | { ok: false; kind: TargetKind; reason: string };

export interface Collection<T extends object, Target> {
  readonly name: string;
  for(target: Target): Document<T>;
  /** The probe: whether this collection would store on `target`, and with which capabilities. */
  where(target: Target): Where;
  /** Drop what the collection remembers about a target — its cached document and subscribers. */
  forget(target: Target): void;
  /**
   * Every target known to hold a document, lazily, from the index. Take a few per tick: the
   * iterator is resumable. A target that cannot be reached right now is still yielded, with
   * `available` false — or readable when its document lives on the world. Slots are never indexed.
   */
  all(): IterableIterator<IndexedDocument<T>>;
  /**
   * The document for one indexed identity, without holding the target — what a remote caller has,
   * since a `Block` or an `Entity` cannot travel over the wire. `undefined` when the collection
   * has no such entry.
   */
  at(kind: TargetKind, identity: string): IndexedDocument<T> | undefined;
  /** How many documents the index knows of. */
  readonly size: number;
}

/**
 * How a kept target is found again for the next operation, and how an index entry becomes a target.
 * The default trusts the handle while it says it is valid and cannot locate by identity;
 * `@bedrock-core/db/minecraft` supplies one that asks the world by id and the dimension by location.
 */
export interface Locator {
  bind(target: unknown, resolution: Accepted): () => unknown;
  /** The target for an identity the index kept, or `undefined` when it is not loaded or gone. */
  fromIdentity(kind: TargetKind, identity: string): unknown;
}

function isValid(target: unknown): boolean {
  if (typeof target !== 'object' || target === null || !('isValid' in target)) {
    return true;
  }

  const valid: unknown = target.isValid;

  return typeof valid === 'function' ? Boolean(valid.call(target)) : valid !== false;
}

export const structuralLocator: Locator = {
  bind: (target): (() => unknown) => (): unknown => (isValid(target) ? target : undefined),
  fromIdentity: (): undefined => undefined,
};

/** The pieces of a block identity, `<dim>:<x>,<y>,<z>:<typeId>`. */
export function parseBlockIdentity(identity: string): { dimensionId: string; x: number; y: number; z: number; typeId: string } | undefined {
  const match = /^(.*):(-?\d+),(-?\d+),(-?\d+):(.*)$/.exec(identity);

  if (match === null) {
    return undefined;
  }

  return { dimensionId: match[1] ?? '', x: Number(match[2]), y: Number(match[3]), z: Number(match[4]), typeId: match[5] ?? '' };
}

/**
 * What `coalesce` and the index need from the engine, wired only when the first coalescing
 * collection is made so a db without one costs nothing per tick.
 */
export interface Lifecycle {
  /** Run `flush` once, later in this tick or next — `system.run` in the engine. */
  schedule(flush: () => void): void;
  /**
   * The current tick. A handle re-resolves its target at most once per tick: within one tick the
   * script is the only thing running, so a target it has not itself removed is still there.
   * Without a clock every operation re-resolves.
   */
  tick?(): number;
  /** Called once; `loaded` must be called with every entity that loads, `leaving` with every player about to leave. */
  attach(hooks: { loaded(target: unknown): void; leaving(target: unknown): void }): void;
}

/**
 * Where a collection's documents are announced to other addons.
 *
 * This package cannot reach the shared mirror itself — it depends on the engine and nothing else —
 * so the runtime injects one backed by `core.shared`. Without it a db announces nothing and costs
 * nothing, which is what keeps an addon that shares no documents off this path entirely.
 */
export interface Mirror {
  /**
   * Announce `value` for one document, or `undefined` to withdraw it.
   *
   * Called at most once per document per tick: publishing is serialization on the caller's tick,
   * measured at 3.1 ms for a 10 KB value ([S6](../../../docs/spikes/S6-shared-bus-cost.md)), so a
   * counter bumped a hundred times a tick must still announce once.
   */
  set(collection: string, key: string, value: unknown): void;
}

export interface DbOptions {
  /** The world: proxied documents and the indexes live on it. */
  world: DirectDp;
  /** Announces documents to peers. Omit and nothing is announced. */
  mirror?: Mirror;
  /** The addon's namespace — the first segment of every key on the world. */
  namespace: string;
  classify?: Classifier;
  locate?: Locator;
  lifecycle?: Lifecycle;
  /** How long a parked document waits for its entity to load again before it is dropped, in milliseconds. Five minutes when omitted. */
  parkFor?: number;
  /** Where quarantine lines go. `console.warn` when omitted. */
  log?: (message: string) => void;
}

export interface Db {
  /**
   * A collection of documents. The document type rides the schema, the target type rides the
   * acceptor — any storable target when there is none — and `require` is checked against what that
   * target type can do:
   * `db.collection('elevators', { schema: schema<Elevator>(), accept: blockTypes('papi:elevator'), require: { own: true } })`.
   */
  collection<T extends object, Target = StorableTarget, R extends Requirements = Requirements>(
    name: string,
    options: CollectionOptions<T, Target, R> & Conflicts<Target, R>,
  ): Collection<T, Target>;
  /**
   * A block at `location` in `dimensionId` of type `typeId` is gone. Drops it from every block
   * collection's index and removes a world-kept document. The block itself is air by the time the
   * engine's `onBreak` runs, which is why this takes the identity, not the block.
   */
  blockRemoved(dimensionId: string, location: { x: number; y: number; z: number }, typeId: string): void;
  /** Write every coalesced document and every dirty index chunk now — all of them, or one target's documents. */
  flush(target?: unknown): void;
  /**
   * A collection already declared under `name`, or `undefined`.
   *
   * Loosely typed on purpose: the caller is the RPC layer, which has a name off the wire and no
   * document type to go with it. Anything that knows the type holds the collection itself.
   */
  find(name: string): Collection<object, unknown> | undefined;
  readonly resolver: Resolver;
}

// ─── Internals ─────────────────────────────────────────────────────────────────

const REQUIREMENTS: readonly (keyof Requirements)[] = ['own', 'enumerable', 'readableWhenUnloaded'];

const REQUIREMENT_TEXT: Record<keyof Requirements, string> = {
  own: 'the document would live on the world, not on the target',
  enumerable: 'the host cannot list keys',
  readableWhenUnloaded: 'the document is only reachable while the target is loaded',
};

/** The one key a collection's document sits under, inside the collection's prefix. */
const DOC = 'doc';

const KINDS: readonly string[] = ['world', 'dimension', 'entity', 'block', 'slot'];

function isKind(value: string): value is TargetKind {
  return KINDS.includes(value);
}

const PARK_FOR = 5 * 60_000;

/** `coalesce` is safe where a dirty document cannot die with its target before the flush. */
const coalescable = (resolution: Accepted): boolean => resolution.host.caps.readableWhenUnloaded || resolution.kind === 'entity';

const NOTHING = (): undefined => undefined;

const NO_LISTENER = (): void => {};

type Admitted = { ok: true; resolution: Accepted } | { ok: false; kind: TargetKind; reason: string };

type State = { ok: true; resolution: Accepted } | { ok: false; reason: string };

interface Stream<T> {
  source: Observable<T | undefined>;
  listeners: number;
}

interface Dirty<T> {
  doc: T;
  last: Accepted;
  find(): unknown;
}

interface Parked<T> {
  doc: T;
  until: number;
}

/** What every collection shares from its db. */
interface Shared {
  readonly namespace: string;
  readonly resolver: Resolver;
  readonly locate: Locator;
  readonly worldHost: DpHost;
  readonly tick: (() => number) | undefined;
  readonly scheduleIndex: ((flush: () => void) => void) | undefined;
  readonly parkFor: number;
  /** Whether a mirror is wired at all. Without one no collection announces. */
  readonly announces: boolean;
  log(message: string): void;
  attach(): void;
  scheduleFlush(): void;
  /** Queue an announcement for `collection`/`key`; coalesced and sent once per tick. */
  announce(collection: string, key: string, value: unknown): void;
}

/** Documents are cached, subscribed and indexed by identity; a slot has none, so each handle stands alone. */
function identityKey(kind: TargetKind, identity: string): string | undefined {
  return kind === 'slot' ? undefined : `${kind}:${identity}`;
}

function typeIdOfEntry(kind: TargetKind, identity: string): string {
  switch (kind) {
    case 'block':
      return parseBlockIdentity(identity)?.typeId ?? '?';
    case 'dimension':
      return identity;
    default:
      return '?';
  }
}

// ─── The handle ────────────────────────────────────────────────────────────────

class Handle<T extends object> implements Document<T> {
  /** Cache, stream and index key: `kind:identity`. Undefined for a slot, which has no identity. */
  readonly key: string | undefined;
  /** The world is one target with one document; it needs no index. */
  private readonly _indexKey: string | undefined;
  private _last: Accepted | undefined;
  private _memo: State | undefined;
  private _memoTick: number;
  private _store: DocumentStore<T> | undefined;
  private _storeFor: Accepted | undefined;
  private _local: Stream<T> | undefined;

  constructor(
    private readonly _c: CollectionImpl<T>,
    private readonly _first: Admitted,
    private _find: () => unknown,
  ) {
    this._last = _first.ok ? _first.resolution : undefined;
    this.key = this._last === undefined ? undefined : identityKey(this._last.kind, this._last.identity);
    this._indexKey = this.key !== undefined && this._last?.kind !== 'world' ? this.key : undefined;
    // `first` was resolved this very tick: the first operation need not resolve again.
    this._memoTick = _c.shared.tick === undefined ? -1 : _c.shared.tick();
    this._memo = _first.ok ? _first : undefined;
  }

  get available(): boolean {
    return this._current().ok;
  }

  get reason(): string | undefined {
    const state = this._current();

    return state.ok ? undefined : state.reason;
  }

  get(): T | undefined {
    const state = this._current();

    return state.ok ? this._read(state.resolution) : undefined;
  }

  set(doc: T): void {
    this._write(this._reachable(), doc);
  }

  patch(changes: Partial<T>): void {
    const resolution = this._reachable();
    const merged: unknown = { ...this._c.defaults, ...this._read(resolution), ...changes };

    this._write(resolution, merged as T); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  delete(): void {
    const state = this._current();
    const resolution = state.ok ? state.resolution : this._last;

    if (resolution === undefined) {
      return;
    }

    const c = this._c;

    if (this.key !== undefined) {
      c.dirty.delete(this.key);
      c.parked.delete(this.key);
    }

    if (state.ok || resolution.host.caps.readableWhenUnloaded) {
      try {
        this._storeOf(resolution).remove(DOC);
      } catch {
        this._memo = undefined;
      }
    }

    if (this.key !== undefined) {
      c.cache.delete(this.key);
      // A peer holding the old value has to learn it is gone, or its query stays warm forever.
      c.announce(this.key, undefined);
    }

    if (this._indexKey !== undefined) {
      c.index.remove(this._indexKey);
    }

    this._notify(undefined);
  }

  subscribe(listener: (doc: T | undefined) => void): Unsubscribe {
    if (!this._first.ok) {
      return NO_LISTENER;
    }

    const c = this._c;
    const key = this.key;
    const entry = key === undefined
      ? (this._local ??= { source: observable<T | undefined>(undefined, { label: `${c.name}/slot` }), listeners: 0 })
      : c.stream(key, c.cache.get(key));
    const release = entry.source.subscribe(listener);
    let released = false;

    entry.listeners++;

    return (): void => {
      if (released) {
        return;
      }

      released = true;
      release();
      entry.listeners--;

      if (entry.listeners === 0 && key !== undefined && c.streams.get(key) === entry) {
        c.streams.delete(key);
      }
    };
  }

  private _current(): State {
    const tick = this._c.shared.tick;

    if (tick === undefined) {
      return this._resolveNow();
    }

    const now = tick();

    if (this._memo !== undefined && this._memoTick === now) {
      return this._memo;
    }

    this._memo = this._resolveNow();
    this._memoTick = now;

    return this._memo;
  }

  private _resolveNow(): State {
    const found = this._find();
    const last = this._last;

    if (found === undefined) {
      // A world property keyed by identity needs no loaded target.
      if (last !== undefined && last.host.caps.readableWhenUnloaded) {
        return { ok: true, resolution: last };
      }

      return { ok: false, reason: this._first.ok ? 'the target is not loaded or no longer exists' : this._first.reason };
    }

    const admitted = this._c.admit(this._c.shared.resolver.resolve(found));

    if (!admitted.ok) {
      return { ok: false, reason: admitted.reason };
    }

    if (last === undefined || admitted.resolution.identity !== last.identity) {
      this._find = this._c.shared.locate.bind(found, admitted.resolution);
    }

    this._last = admitted.resolution;

    return admitted;
  }

  private _reachable(): Accepted {
    const state = this._current();

    if (!state.ok) {
      throw new DbTargetError(this._c.name, state.reason);
    }

    return state.resolution;
  }

  /** The store for a resolution, kept while the resolution object is the same one. */
  private _storeOf(resolution: Accepted): DocumentStore<T> {
    if (this._store === undefined || this._storeFor !== resolution) {
      this._store = this._c.storeFor(resolution);
      this._storeFor = resolution;
    }

    return this._store;
  }

  private _notify(doc: T | undefined): void {
    (this.key === undefined ? this._local : this._c.streams.get(this.key))?.source.set(doc);
  }

  private _read(resolution: Accepted): T | undefined {
    const c = this._c;
    const key = this.key;

    if (key !== undefined && c.cache.has(key)) {
      return c.cache.get(key);
    }

    const doc = this._storeOf(resolution).read(DOC);

    if (key !== undefined) {
      c.cache.set(key, doc);
    }

    return doc;
  }

  private _write(resolution: Accepted, doc: T): void {
    const c = this._c;
    const key = this.key;

    if (c.coalesce && key !== undefined) {
      c.dirty.set(key, { doc, last: resolution, find: (): unknown => this._find() });
      c.shared.scheduleFlush();
    } else {
      // An engine throw on a target the memo still trusted — removed by this very script this
      // tick — becomes ours.
      try {
        this._storeOf(resolution).write(DOC, doc);
      } catch (error) {
        this._memo = undefined;

        if (error instanceof DbBudgetError) {
          throw error;
        }

        throw new DbTargetError(c.name, `the target is gone: ${String(error)}`);
      }
    }

    if (key !== undefined) {
      c.cache.set(key, doc);
      c.announce(key, doc);
    }

    if (this._indexKey !== undefined) {
      c.index.add(this._indexKey);
    }

    this._notify(doc);
  }
}

class IndexedHandle<T extends object> extends Handle<T> implements IndexedDocument<T> {
  constructor(c: CollectionImpl<T>, first: Admitted, find: () => unknown, readonly kind: TargetKind, readonly identity: string) {
    super(c, first, find);
  }
}

// ─── The collection ────────────────────────────────────────────────────────────

class CollectionImpl<T extends object> implements Collection<T, unknown> {
  readonly coalesce: boolean;

  /** How a write is announced to peers. `null` when this collection announces nothing. */
  readonly share: 'stamp' | true | ((doc: T) => unknown) | null;
  readonly defaults: Partial<T> | undefined;
  readonly cache = new Map<string, T | undefined>();
  readonly streams = new Map<string, Stream<T>>();
  readonly dirty = new Map<string, Dirty<T>>();
  readonly parked = new Map<string, Parked<T>>();
  readonly index: IndexSet;
  readonly kinds: readonly TargetKind[] | undefined;
  private readonly _acceptor: Acceptor<unknown> | undefined;
  private readonly _require: Requirements | undefined;
  private readonly _schema: DocumentSchema<T>;
  private readonly _accepted = new Map<string, boolean>();
  private _stamp = 0;

  constructor(readonly shared: Shared, readonly name: string, options: CollectionOptions<T, unknown, Requirements>) {
    this._acceptor = options.accept;
    this._require = options.require;
    this._schema = options.schema;
    this.defaults = options.schema.defaults;
    this.coalesce = options.coalesce === true;

    // A db with no mirror announces nothing at all, so an addon that shares no documents never
    // reaches the publish path. With one, the default is the stamp: peers learn a key changed
    // without this addon paying to serialize a document nobody asked for.
    this.share = !shared.announces
      ? null
      : options.shared === undefined || options.shared === false
        ? 'stamp'
        : options.shared === true ? true : options.shared.as;

    this.kinds = options.accept?.kinds;
    this.index = createIndexSet(prefixed(shared.worldHost, `core-db:${shared.namespace}:index:${name}:`), { schedule: shared.scheduleIndex });

    if (this.coalesce) {
      shared.attach();
    }
  }

  get size(): number {
    return this.index.size;
  }

  for(target: unknown): Document<T> {
    const first = this.admit(this.shared.resolver.resolve(target));

    return new Handle(this, first, first.ok ? this.shared.locate.bind(target, first.resolution) : NOTHING);
  }

  where(target: unknown): Where {
    const admitted = this.admit(this.shared.resolver.resolve(target));

    return admitted.ok
      ? { ok: true, kind: admitted.resolution.kind, caps: admitted.resolution.host.caps }
      : admitted;
  }

  forget(target: unknown): void {
    const resolution = this.shared.resolver.resolve(target);
    const key = resolution.ok ? identityKey(resolution.kind, resolution.identity) : undefined;

    if (key === undefined) {
      return;
    }

    this.cache.delete(key);
    this.streams.delete(key);
  }

  * all(): IterableIterator<IndexedDocument<T>> {
    for (const entry of [...this.index.entries()]) {
      const at = entry.indexOf(':');
      const kind = entry.slice(0, at);
      const identity = entry.slice(at + 1);

      if (!isKind(kind)) {
        this.index.remove(entry);
        continue;
      }

      const doc = this._handleForEntry(kind, identity);

      if (doc !== undefined) {
        yield doc;
      }
    }
  }

  at(kind: TargetKind, identity: string): IndexedDocument<T> | undefined {
    return this._handleForEntry(kind, identity);
  }

  admit(resolution: Resolution): Admitted {
    if (!resolution.ok) {
      return { ok: false, kind: resolution.kind, reason: resolution.reason };
    }

    if (this._acceptor !== undefined) {
      let pass = this._accepted.get(resolution.typeKey);

      if (pass === undefined) {
        pass = accepts(this._acceptor, resolution.typeId, resolution.kind);
        this._accepted.set(resolution.typeKey, pass);
      }

      if (!pass) {
        return { ok: false, kind: resolution.kind, reason: `${resolution.typeId} is not accepted by '${this.name}'` };
      }
    }

    if (this._require !== undefined) {
      for (const requirement of REQUIREMENTS) {
        if (this._require[requirement] === true && !resolution.host.caps[requirement]) {
          return { ok: false, kind: resolution.kind, reason: `require.${requirement}: ${REQUIREMENT_TEXT[requirement]}` };
        }
      }
    }

    if (this.coalesce && !coalescable(resolution)) {
      return { ok: false, kind: resolution.kind, reason: `coalesce: a ${resolution.kind} document could die with its target before the flush` };
    }

    return { ok: true, resolution };
  }

  storeFor(resolution: Accepted): DocumentStore<T> {
    return createDocumentStore<T>(prefixed(resolution.host, resolution.prefixFor(this.name)), { ...this._schema, collection: this.name, log: this.shared.log });
  }

  stream(key: string, initial: T | undefined): Stream<T> {
    let entry = this.streams.get(key);

    if (entry === undefined) {
      entry = { source: observable<T | undefined>(initial, { label: `${this.name}/${key}` }), listeners: 0 };
      this.streams.set(key, entry);
    }

    return entry;
  }

  /** A block or entity is gone for good, by identity. */
  removed(kind: TargetKind, typeId: string, identity: string): void {
    const key = identityKey(kind, identity);

    if (key !== undefined && this.index.has(key)) {
      this._dropIdentity(key, this.shared.resolver.absent(kind, typeId, identity));
      // A peer holding the old value has to learn it is gone, or its query stays warm forever.
      this.announce(key, undefined);
    }
  }

  /**
   * Queue what peers should see of one document. `undefined` withdraws it.
   *
   * The stamp is a counter rather than the document's schema version: a write that does not change
   * the version still has to invalidate a peer's query, and a peer only compares the value with
   * what it last saw.
   */
  announce(key: string, doc: T | undefined): void {
    const share = this.share;

    if (share === null) {
      return;
    }

    if (doc === undefined) {
      this.shared.announce(this.name, key, undefined);

      return;
    }

    if (share === 'stamp') {
      this.shared.announce(this.name, key, ++this._stamp);
    } else if (share === true) {
      this.shared.announce(this.name, key, doc);
    } else {
      this.shared.announce(this.name, key, share(doc));
    }
  }

  /** Write the dirty documents — all, or one key — parking those whose entity is away; then the index. */
  flush(only?: string): void {
    for (const [key, entry] of [...this.dirty]) {
      if (only !== undefined && key !== only) {
        continue;
      }

      this.dirty.delete(key);

      const resolution = this._flushTarget(entry);

      if (resolution === undefined) {
        this.parked.set(key, { doc: entry.doc, until: Date.now() + this.shared.parkFor });
        continue;
      }

      this.storeFor(resolution).write(DOC, entry.doc);
    }

    this.index.flush();
  }

  /** An entity came back: write its parked document, and drop parked documents past their time. */
  loaded(target: unknown): void {
    if (this.parked.size === 0) {
      return;
    }

    const now = Date.now();

    for (const [key, entry] of [...this.parked]) {
      if (entry.until <= now) {
        this.parked.delete(key);
        this.shared.log(`[db] ${this.name}: dropped a document parked for '${key}' — its target did not load again in time`);
      }
    }

    const resolution = this.shared.resolver.resolve(target);

    if (!resolution.ok) {
      return;
    }

    const key = identityKey(resolution.kind, resolution.identity);
    const waiting = key === undefined ? undefined : this.parked.get(key);

    if (key === undefined || waiting === undefined) {
      return;
    }

    this.parked.delete(key);
    this.storeFor(resolution).write(DOC, waiting.doc);
  }

  /** Where a dirty document goes now: its target found again, or the world when the document lives there. */
  private _flushTarget(entry: Dirty<T>): Accepted | undefined {
    const found = entry.find();

    if (found === undefined) {
      return entry.last.host.caps.readableWhenUnloaded ? entry.last : undefined;
    }

    const resolved = this.shared.resolver.resolve(found);

    return resolved.ok && resolved.identity === entry.last.identity ? resolved : undefined;
  }

  /** The identity is gone for good: forget it, tell subscribers, and remove a world-kept document. */
  private _dropIdentity(key: string, resolution: Accepted | undefined): void {
    if (resolution !== undefined && resolution.host.caps.readableWhenUnloaded) {
      this.storeFor(resolution).remove(DOC);
    }

    this.cache.delete(key);
    this.streams.get(key)?.source.set(undefined);
    this.streams.delete(key);
    this.index.remove(key);
  }

  /** A handle for an index entry: the located target when it is at hand, else the world-kept document, else nothing reachable. */
  private _handleForEntry(kind: TargetKind, identity: string): IndexedDocument<T> | undefined {
    const key = `${kind}:${identity}`;
    const located = this.shared.locate.fromIdentity(kind, identity);

    if (located !== undefined) {
      const resolved = this.shared.resolver.resolve(located);

      // The index said one thing, the world holds another: a block of another type now stands
      // there (the identity carries the type). Whatever was kept for the old one is gone or orphaned.
      if (resolved.ok && resolved.identity !== identity) {
        this._dropIdentity(key, this.shared.resolver.absent(kind, typeIdOfEntry(kind, identity), identity));

        return undefined;
      }

      const first = this.admit(resolved);

      return new IndexedHandle(this, first, first.ok ? this.shared.locate.bind(located, first.resolution) : NOTHING, kind, identity);
    }

    const absent = this.shared.resolver.absent(kind, typeIdOfEntry(kind, identity), identity);
    const first: Admitted = absent === undefined
      ? { ok: false, kind, reason: 'the target is not loaded or no longer exists' }
      : this.admit(absent);

    return new IndexedHandle(this, first, NOTHING, kind, identity);
  }
}

// ─── The db ────────────────────────────────────────────────────────────────────

export function createDb(options: DbOptions): Db {
  const { world, namespace } = options;
  const resolver = createResolver({ world, namespace, classify: options.classify });
  const collections: CollectionImpl<object>[] = [];
  const lifecycle = options.lifecycle;
  let attached = false;
  let flushScheduled = false;

  const keyOf = (target: unknown): string | undefined => {
    const resolution = resolver.resolve(target);

    return resolution.ok ? identityKey(resolution.kind, resolution.identity) : undefined;
  };

  const flushAll = (key?: string): void => {
    flushScheduled = false;

    for (const collection of collections) {
      collection.flush(key);
    }
  };

  const mirror = options.mirror;

  /**
   * Announcements waiting for the end of the tick, latest value per document.
   *
   * Coalesced because publishing is serialization on this addon's own tick — 3.1 ms for a 10 KB
   * value ([S6](../../../docs/spikes/S6-shared-bus-cost.md)) — so a document written a hundred
   * times in one tick must still be announced once. Delivery is not the cost: a delta reaches four
   * peers in the same tick either way.
   */
  const pending = new Map<string, { collection: string; key: string; value: unknown }>();
  let announceScheduled = false;

  const announceAll = (): void => {
    announceScheduled = false;

    for (const { collection, key, value } of pending.values()) {
      mirror?.set(collection, key, value);
    }

    pending.clear();
  };

  const shared: Shared = {
    namespace,
    resolver,
    locate: options.locate ?? structuralLocator,
    worldHost: directHost(world, { readableWhenUnloaded: true }),
    tick: lifecycle?.tick?.bind(lifecycle),
    scheduleIndex: lifecycle === undefined ? undefined : lifecycle.schedule.bind(lifecycle),
    parkFor: options.parkFor ?? PARK_FOR,
    announces: mirror !== undefined,

    announce: (collection, key, value): void => {
      pending.set(`${collection}/${key}`, { collection, key, value });

      if (announceScheduled) {
        return;
      }

      announceScheduled = true;

      // Without a lifecycle there is no tick to wait for, so this stays synchronous — which is
      // also what the unit tests see.
      if (lifecycle === undefined) {
        announceAll();
      } else {
        lifecycle.schedule(announceAll);
      }
    },

    log: options.log ?? ((message: string): void => {
      console.warn(message);
    }),

    /** The first coalescing collection wires the engine hooks; a db without one never does. */
    attach: (): void => {
      if (attached) {
        return;
      }

      attached = true;
      lifecycle?.attach({
        loaded: (target): void => {
          for (const collection of collections) {
            collection.loaded(target);
          }
        },
        leaving: (target): void => {
          flushAll(keyOf(target));
        },
      });
    },

    scheduleFlush: (): void => {
      if (flushScheduled) {
        return;
      }

      flushScheduled = true;

      if (lifecycle === undefined) {
        flushAll();
      } else {
        lifecycle.schedule(() => flushAll());
      }
    },
  };

  return {
    resolver,

    collection<T extends object, Target, R extends Requirements>(name: string, collectionOptions: CollectionOptions<T, Target, R>): Collection<T, Target> {
      // The acceptor's brand is compile-time only; at runtime every collection handles `unknown`.
      const impl = new CollectionImpl<T>(shared, name, collectionOptions as CollectionOptions<T, unknown, Requirements>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

      collections.push(impl as unknown as CollectionImpl<object>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

      return impl;
    },

    flush: (target): void => {
      flushAll(target === undefined ? undefined : keyOf(target));
    },

    find: (name): Collection<object, unknown> | undefined => collections.find(collection => collection.name === name),

    blockRemoved: (dimensionId, location, typeId): void => {
      const identity = `${dimensionId}:${location.x},${location.y},${location.z}:${typeId}`;

      for (const collection of collections) {
        if (collection.kinds === undefined || collection.kinds.includes('block')) {
          collection.removed('block', typeId, identity);
        }
      }
    },
  };
}
