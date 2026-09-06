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
 * by identity once read; a container slot has no identity, so its documents are read each time.
 */
import { observable, type Observable, type Unsubscribe } from '@bedrock-core/observable';
import { accepts, type Acceptor, type Conflicts, type Requirements, type StorableTarget } from './accept';
import { createDocumentStore, type DocumentSchema, type DocumentStore, type Schema } from './document';
import { DbTargetError } from './errors';
import type { Capabilities } from './host';
import { prefixed } from './host';
import type { Resolution, Resolver, TargetKind } from './resolve';

export interface CollectionOptions<T extends object, Target, R extends Requirements> {
  /** The document type, with its version, defaults and migrations: `schema<Elevator>({ version: 2 })`. */
  schema: Schema<T>;
  /** Which targets may carry a document. Anything the resolver can host when omitted. */
  accept?: Acceptor<Target>;
  /** What the host must offer; a target whose host lacks it is refused with a reason instead of silently stored elsewhere. */
  require?: R;
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
}

type Accepted = Resolution & { ok: true };

/**
 * How a kept target is found again for the next operation. The default trusts the handle while it
 * says it is valid; `@bedrock-core/db/minecraft` supplies one that asks the world by id and the
 * dimension by location.
 */
export interface Locator {
  bind(target: unknown, resolution: Accepted): () => unknown;
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
};

export interface DbOptions {
  resolver: Resolver;
  locate?: Locator;
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
}

const REQUIREMENTS: readonly (keyof Requirements)[] = ['own', 'enumerable', 'readableWhenUnloaded'];

const REQUIREMENT_TEXT: Record<keyof Requirements, string> = {
  own: 'the document would live on the world, not on the target',
  enumerable: 'the host cannot list keys',
  readableWhenUnloaded: 'the document is only reachable while the target is loaded',
};

/** The one key a collection's document sits under, inside the collection's prefix. */
const DOC = 'doc';

type Admitted = { ok: true; resolution: Accepted } | { ok: false; kind: TargetKind; reason: string };

interface Stream<T> {
  source: Observable<T | undefined>;
  listeners: number;
}

export function createDb(options: DbOptions): Db {
  const { resolver } = options;
  const locate = options.locate ?? structuralLocator;

  function collection<T extends object, Target, R extends Requirements>(
    name: string,
    collectionOptions: CollectionOptions<T, Target, R>,
  ): Collection<T, Target> {
    const acceptor = collectionOptions.accept;
    const require = collectionOptions.require;
    const schema: DocumentSchema<T> = collectionOptions.schema;
    const defaults = schema.defaults;
    const accepted = new Map<string, boolean>();
    const cache = new Map<string, T | undefined>();
    const streams = new Map<string, Stream<T>>();

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

      return { ok: true, resolution };
    };

    const storeFor = (resolution: Accepted): DocumentStore<T> =>
      createDocumentStore<T>(prefixed(resolution.host, resolution.prefixFor(name)), { ...schema, collection: name, log: options.log });

    /** Documents are cached and subscribed by identity; a slot has none, so each handle stands alone. */
    const cacheKey = (resolution: Accepted): string | undefined =>
      (resolution.kind === 'slot' ? undefined : `${resolution.kind}:${resolution.identity}`);

    const stream = (key: string, initial: T | undefined): Stream<T> => {
      let entry = streams.get(key);

      if (entry === undefined) {
        entry = { source: observable<T | undefined>(initial, { label: `${name}/${key}` }), listeners: 0 };
        streams.set(key, entry);
      }

      return entry;
    };

    const handle = (target: unknown): Document<T> => {
      const first = admit(resolver.resolve(target));
      let find: () => unknown = first.ok ? locate.bind(target, first.resolution) : (): unknown => undefined;
      let last: Accepted | undefined = first.ok ? first.resolution : undefined;
      const key = last === undefined ? undefined : cacheKey(last);
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
        storeFor(resolution).write(DOC, doc);

        if (key !== undefined) {
          cache.set(key, doc);
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

          if (state.ok || resolution.host.caps.readableWhenUnloaded) {
            storeFor(resolution).remove(DOC);
          }

          if (key !== undefined) {
            cache.delete(key);
          }

          notify(undefined);
        },

        subscribe: (listener): Unsubscribe => {
          if (first.ok === false) {
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

    return {
      name,

      for: (target): Document<T> => handle(target),

      where: (target): Where => {
        const admitted = admit(resolver.resolve(target));

        return admitted.ok
          ? { ok: true, kind: admitted.resolution.kind, caps: admitted.resolution.host.caps }
          : admitted;
      },

      forget: (target): void => {
        const resolution = resolver.resolve(target);
        const key = resolution.ok ? cacheKey(resolution) : undefined;

        if (key === undefined) {
          return;
        }

        cache.delete(key);
        streams.delete(key);
      },
    };
  }

  return { collection };
}
