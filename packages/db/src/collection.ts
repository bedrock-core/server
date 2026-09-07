/**
 * A collection: typed documents keyed by target, stored wherever the target can hold bytes.
 *
 * `for(target)` keeps an identity and a way to find the target again, never the handle it was
 * given — a `Block` goes stale when its chunk unloads, an `Entity` after removal — and every
 * operation re-resolves. Reads answer `undefined` when the target cannot be reached; writes throw
 * `DbTargetError` naming the collection, because writing to nothing is a bug at the call site.
 * A proxied document (world property keyed by identity) stays readable while its target is
 * unloaded, since the world needs no chunk.
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
 */
import { observable, type Observable, type Unsubscribe } from '@bedrock-core/observable';
import { accepts, type Acceptor, type Conflicts, type Requirements, type StorableTarget } from './accept';
import { createDocumentStore, type DocumentSchema, type DocumentStore, type Schema } from './document';
import { DbTargetError } from './errors';
import { directHost, prefixed, type Capabilities, type DirectDp } from './host';
import { createIndexSet, type IndexSet } from './indexed';
import { createResolver, type Classifier, type Resolution, type Resolver, type TargetKind } from './resolve';

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
  /** How many documents the index knows of. */
  readonly size: number;
}

type Accepted = Resolution & { ok: true };

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
 * What `coalesce` needs from the engine, wired only when the first coalescing collection is made
 * so a db without one costs nothing per tick.
 */
export interface Lifecycle {
  /** Run `flush` once, later in this tick or next — `system.run` in the engine. */
  schedule(flush: () => void): void;
  /** Called once; `loaded` must be called with every entity that loads, `leaving` with every player about to leave. */
  attach(hooks: { loaded(target: unknown): void; leaving(target: unknown): void }): void;
}

export interface DbOptions {
  /** The world: proxied documents and the indexes live on it. */
  world: DirectDp;
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
  /** Write every coalesced document now — all of them, or those of one target. */
  flush(target?: unknown): void;
  readonly resolver: Resolver;
}

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

type Admitted = { ok: true; resolution: Accepted } | { ok: false; kind: TargetKind; reason: string };

interface Stream<T> {
  source: Observable<T | undefined>;
  listeners: number;
}

/** What a collection exposes to the db for cleanup by identity and for flushing. */
interface Registered {
  readonly kinds: readonly TargetKind[] | undefined;
  removed(kind: TargetKind, typeId: string, identity: string): void;
  flush(key?: string): void;
  /** An entity is back: write what was parked for it. */
  loaded(target: unknown): void;
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

const PARK_FOR = 5 * 60_000;

/** `coalesce` is safe where a dirty document cannot die with its target before the flush. */
const coalescable = (resolution: Accepted): boolean => resolution.host.caps.readableWhenUnloaded || resolution.kind === 'entity';

export function createDb(options: DbOptions): Db {
  const { world, namespace } = options;
  const resolver = createResolver({ world, namespace, classify: options.classify });
  const locate = options.locate ?? structuralLocator;
  const log = options.log ?? ((message: string): void => {
    console.warn(message);
  });
  const worldHost = directHost(world, { readableWhenUnloaded: true });
  const registered: Registered[] = [];
  const parkFor = options.parkFor ?? PARK_FOR;
  let attached = false;
  let flushScheduled = false;

  const keyOf = (target: unknown): string | undefined => {
    const resolution = resolver.resolve(target);

    return resolution.ok && resolution.kind !== 'slot' ? `${resolution.kind}:${resolution.identity}` : undefined;
  };

  const flushAll = (key?: string): void => {
    flushScheduled = false;

    for (const entry of registered) {
      entry.flush(key);
    }
  };

  /** The first coalescing collection wires the engine hooks; a db without one never does. */
  const attach = (): void => {
    if (attached) {
      return;
    }

    attached = true;
    options.lifecycle?.attach({
      loaded: (target): void => {
        for (const entry of registered) {
          entry.loaded(target);
        }
      },
      leaving: (target): void => {
        flushAll(keyOf(target));
      },
    });
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) {
      return;
    }

    flushScheduled = true;

    if (options.lifecycle === undefined) {
      queueMicrotask(() => flushAll());
    } else {
      options.lifecycle.schedule(() => flushAll());
    }
  };

  function collection<T extends object, Target, R extends Requirements>(
    name: string,
    collectionOptions: CollectionOptions<T, Target, R>,
  ): Collection<T, Target> {
    const acceptor = collectionOptions.accept;
    const require = collectionOptions.require;
    const coalesce = collectionOptions.coalesce === true;
    const schema: DocumentSchema<T> = collectionOptions.schema;
    const defaults = schema.defaults;
    const accepted = new Map<string, boolean>();
    const cache = new Map<string, T | undefined>();
    const streams = new Map<string, Stream<T>>();
    const index: IndexSet = createIndexSet(prefixed(worldHost, `core-db:${namespace}:index:${name}:`));
    const dirty = new Map<string, Dirty<T>>();
    const parked = new Map<string, Parked<T>>();

    if (coalesce) {
      attach();
    }

    const admit = (resolution: Resolution): Admitted => {
      if (!resolution.ok) {
        return { ok: false, kind: resolution.kind, reason: resolution.reason };
      }

      if (acceptor !== undefined) {
        let pass = accepted.get(resolution.typeKey);

        if (pass === undefined) {
          pass = accepts(acceptor, resolution.typeId, resolution.kind);
          accepted.set(resolution.typeKey, pass);
        }

        if (!pass) {
          return { ok: false, kind: resolution.kind, reason: `${resolution.typeId} is not accepted by '${name}'` };
        }
      }

      if (require !== undefined) {
        for (const requirement of REQUIREMENTS) {
          if (require[requirement] === true && !resolution.host.caps[requirement]) {
            return { ok: false, kind: resolution.kind, reason: `require.${requirement}: ${REQUIREMENT_TEXT[requirement]}` };
          }
        }
      }

      if (coalesce && !coalescable(resolution)) {
        return { ok: false, kind: resolution.kind, reason: `coalesce: a ${resolution.kind} document could die with its target before the flush` };
      }

      return { ok: true, resolution };
    };

    const storeFor = (resolution: Accepted): DocumentStore<T> =>
      createDocumentStore<T>(prefixed(resolution.host, resolution.prefixFor(name)), { ...schema, collection: name, log });

    /** Where a dirty document goes now: its target found again, or the world when the document lives there. */
    const flushTarget = (entry: Dirty<T>): Accepted | undefined => {
      const found = entry.find();

      if (found === undefined) {
        return entry.last.host.caps.readableWhenUnloaded ? entry.last : undefined;
      }

      const resolved = resolver.resolve(found);

      return resolved.ok && resolved.identity === entry.last.identity ? resolved : undefined;
    };

    /** Write the dirty documents — all, or one key — parking those whose entity is away. */
    const flush = (only?: string): void => {
      for (const [key, entry] of [...dirty]) {
        if (only !== undefined && key !== only) {
          continue;
        }

        dirty.delete(key);

        const resolution = flushTarget(entry);

        if (resolution === undefined) {
          parked.set(key, { doc: entry.doc, until: Date.now() + parkFor });
          continue;
        }

        storeFor(resolution).write(DOC, entry.doc);
      }
    };

    /** An entity came back: write its parked document, and drop parked documents past their time. */
    const loaded = (target: unknown): void => {
      if (parked.size === 0) {
        return;
      }

      const now = Date.now();

      for (const [key, entry] of [...parked]) {
        if (entry.until <= now) {
          parked.delete(key);
          log(`[db] ${name}: dropped a document parked for '${key}' — its target did not load again in time`);
        }
      }

      const resolution = resolver.resolve(target);

      if (!resolution.ok) {
        return;
      }

      const key = identityKey(resolution.kind, resolution.identity);
      const waiting = key === undefined ? undefined : parked.get(key);

      if (key === undefined || waiting === undefined) {
        return;
      }

      parked.delete(key);
      storeFor(resolution).write(DOC, waiting.doc);
    };

    /** Documents are cached, subscribed and indexed by identity; a slot has none, so each handle stands alone. */
    const identityKey = (kind: TargetKind, identity: string): string | undefined =>
      (kind === 'slot' ? undefined : `${kind}:${identity}`);

    const stream = (key: string, initial: T | undefined): Stream<T> => {
      let entry = streams.get(key);

      if (entry === undefined) {
        entry = { source: observable<T | undefined>(initial, { label: `${name}/${key}` }), listeners: 0 };
        streams.set(key, entry);
      }

      return entry;
    };

    /** The identity is gone for good: forget it, tell subscribers, and remove a world-kept document. */
    const dropIdentity = (key: string, resolution: Accepted | undefined): void => {
      if (resolution !== undefined && resolution.host.caps.readableWhenUnloaded) {
        storeFor(resolution).remove(DOC);
      }

      cache.delete(key);
      streams.get(key)?.source.set(undefined);
      streams.delete(key);
      index.remove(key);
    };

    /**
     * One document. `first` is how the target resolved when the handle was made; `find` locates it
     * again for every operation. A handle made from an index entry whose target is not at hand
     * starts with `find` answering nothing and, when the document lives on the world, still reads.
     */
    const handle = (first: Admitted, find: () => unknown): Document<T> => {
      let last: Accepted | undefined = first.ok ? first.resolution : undefined;
      const key = last === undefined ? undefined : identityKey(last.kind, last.identity);
      // The world is one target with one document; it needs no index.
      const indexKey = key !== undefined && last?.kind !== 'world' ? key : undefined;
      let local: Stream<T> | undefined;

      const current = (): { ok: true; resolution: Accepted } | { ok: false; reason: string } => {
        const found = find();

        if (found === undefined) {
          // A world property keyed by identity needs no loaded target.
          if (last !== undefined && last.host.caps.readableWhenUnloaded) {
            return { ok: true, resolution: last };
          }

          return { ok: false, reason: first.ok ? 'the target is not loaded or no longer exists' : first.reason };
        }

        const admitted = admit(resolver.resolve(found));

        if (!admitted.ok) {
          return { ok: false, reason: admitted.reason };
        }

        if (last === undefined || admitted.resolution.identity !== last.identity) {
          find = locate.bind(found, admitted.resolution);
        }

        last = admitted.resolution;

        return admitted;
      };

      const notify = (doc: T | undefined): void => {
        (key === undefined ? local : streams.get(key))?.source.set(doc);
      };

      const read = (resolution: Accepted): T | undefined => {
        if (key !== undefined && cache.has(key)) {
          return cache.get(key);
        }

        const doc = storeFor(resolution).read(DOC);

        if (key !== undefined) {
          cache.set(key, doc);
        }

        return doc;
      };

      const write = (resolution: Accepted, doc: T): void => {
        if (coalesce && key !== undefined) {
          dirty.set(key, { doc, last: resolution, find: (): unknown => find() });
          scheduleFlush();
        } else {
          storeFor(resolution).write(DOC, doc);
        }

        if (key !== undefined) {
          cache.set(key, doc);
        }

        if (indexKey !== undefined) {
          index.add(indexKey);
        }

        notify(doc);
      };

      const reachable = (): Accepted => {
        const state = current();

        if (!state.ok) {
          throw new DbTargetError(name, state.reason);
        }

        return state.resolution;
      };

      return {
        get available(): boolean {
          return current().ok;
        },

        get reason(): string | undefined {
          const state = current();

          return state.ok ? undefined : state.reason;
        },

        get: (): T | undefined => {
          const state = current();

          return state.ok ? read(state.resolution) : undefined;
        },

        set: (doc): void => {
          write(reachable(), doc);
        },

        patch: (changes): void => {
          const resolution = reachable();
          const merged: unknown = { ...defaults, ...read(resolution), ...changes };

          write(resolution, merged as T); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        },

        delete: (): void => {
          const state = current();
          const resolution = state.ok ? state.resolution : last;

          if (resolution === undefined) {
            return;
          }

          if (key !== undefined) {
            dirty.delete(key);
            parked.delete(key);
          }

          if (state.ok || resolution.host.caps.readableWhenUnloaded) {
            storeFor(resolution).remove(DOC);
          }

          if (key !== undefined) {
            cache.delete(key);
          }

          if (indexKey !== undefined) {
            index.remove(indexKey);
          }

          notify(undefined);
        },

        subscribe: (listener): Unsubscribe => {
          if (!first.ok) {
            return (): void => {};
          }

          const entry = key === undefined
            ? (local ??= { source: observable<T | undefined>(undefined, { label: `${name}/slot` }), listeners: 0 })
            : stream(key, cache.get(key));
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

            if (entry.listeners === 0 && key !== undefined && streams.get(key) === entry) {
              streams.delete(key);
            }
          };
        },
      };
    };

    const handleFor = (target: unknown): Document<T> => {
      const first = admit(resolver.resolve(target));

      return handle(first, first.ok ? locate.bind(target, first.resolution) : (): unknown => undefined);
    };

    const typeIdOfEntry = (kind: TargetKind, identity: string): string => {
      switch (kind) {
        case 'block':
          return parseBlockIdentity(identity)?.typeId ?? '?';
        case 'dimension':
          return identity;
        default:
          return '?';
      }
    };

    /** A handle for an index entry: the located target when it is at hand, else the world-kept document, else nothing reachable. */
    const handleForEntry = (kind: TargetKind, identity: string): IndexedDocument<T> | undefined => {
      const key = `${kind}:${identity}`;
      const located = locate.fromIdentity(kind, identity);
      let first: Admitted;
      let find: () => unknown;

      if (located !== undefined) {
        const resolved = resolver.resolve(located);

        // The index said one thing, the world holds another: a block of another type now stands
        // there (the identity carries the type). Whatever was kept for the old one is gone or orphaned.
        if (resolved.ok && resolved.identity !== identity) {
          dropIdentity(key, resolver.absent(kind, typeIdOfEntry(kind, identity), identity));

          return undefined;
        }

        first = admit(resolved);
        find = first.ok ? locate.bind(located, first.resolution) : (): unknown => undefined;
      } else {
        const absent = resolver.absent(kind, typeIdOfEntry(kind, identity), identity);

        first = absent === undefined
          ? { ok: false, kind, reason: 'the target is not loaded or no longer exists' }
          : admit(absent);
        find = (): unknown => undefined;
      }

      return Object.assign(handle(first, find), { kind, identity });
    };

    function* all(): IterableIterator<IndexedDocument<T>> {
      for (const entry of [...index.entries()]) {
        const at = entry.indexOf(':');
        const kind = entry.slice(0, at);
        const identity = entry.slice(at + 1);

        if (!isKind(kind)) {
          index.remove(entry);
          continue;
        }

        const doc = handleForEntry(kind, identity);

        if (doc !== undefined) {
          yield doc;
        }
      }
    }

    registered.push({
      kinds: acceptor?.kinds,
      removed: (kind, typeId, identity): void => {
        const key = identityKey(kind, identity);

        if (key !== undefined && index.has(key)) {
          dropIdentity(key, resolver.absent(kind, typeId, identity));
        }
      },
      flush,
      loaded,
    });

    return {
      name,

      for: (target): Document<T> => handleFor(target),

      where: (target): Where => {
        const admitted = admit(resolver.resolve(target));

        return admitted.ok
          ? { ok: true, kind: admitted.resolution.kind, caps: admitted.resolution.host.caps }
          : admitted;
      },

      forget: (target): void => {
        const resolution = resolver.resolve(target);
        const key = resolution.ok ? identityKey(resolution.kind, resolution.identity) : undefined;

        if (key === undefined) {
          return;
        }

        cache.delete(key);
        streams.delete(key);
      },

      all,

      get size(): number {
        return index.size;
      },
    };
  }

  return {
    collection,
    resolver,
    flush: (target): void => {
      flushAll(target === undefined ? undefined : keyOf(target));
    },
    blockRemoved: (dimensionId, location, typeId): void => {
      const identity = `${dimensionId}:${location.x},${location.y},${location.z}:${typeId}`;

      for (const entry of registered) {
        if (entry.kinds === undefined || entry.kinds.includes('block')) {
          entry.removed('block', typeId, identity);
        }
      }
    },
  };
}
