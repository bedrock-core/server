/**
 * Config nodes satisfy the observable contract.
 *
 * The reactive primitive is three verbs — `get` / `set` / `subscribe` — and a config node is meant
 * to be one of the things that has them, so `useObservable(config.server.taxRate)` reads a config
 * leaf the same way it reads an addon's own observable or a db document. Nothing imports anything
 * here: the guarantee is structural, which is what lets the UI package accept a config node without
 * depending on this one.
 *
 * Compiled by `tsc`, never run. A shape that stops matching fails the build.
 */
import type { ConfigGroupAccessor, ConfigLeafAccessor } from '../scopes/scope';

/**
 * The read half of an observable, as `@bedrock-core/observable` declares it and as
 * `ui-runtime`'s `useObservable` accepts it.
 */
interface ReadonlyObservableLike<T> {
  get(): T;
  subscribe(listener: (next: T, prev: T) => void): () => void;
}

/** The write half, so a leaf is a full observable rather than only a readable one. */
interface ObservableLike<T> extends ReadonlyObservableLike<T> {
  set(value: T): void;
}

type Schema = {
  taxRate: { type: 'number'; default: number };
  currency: { type: 'enum'; options: ['emerald', 'gold']; default: 'emerald' };
};

declare const leaf: ConfigLeafAccessor<Schema['taxRate']>;
declare const enumLeaf: ConfigLeafAccessor<Schema['currency']>;
declare const group: ConfigGroupAccessor<Schema>;

// A leaf is an observable of its own value type.
export const leafIsObservable: ObservableLike<number> = leaf;

// An enum leaf narrows to its literal union rather than widening to string.
export const enumLeafIsObservable: ObservableLike<'emerald' | 'gold'> = enumLeaf;

// A group is an observable of its whole reconstructed shape.
export const groupIsObservable: ObservableLike<{ taxRate: number; currency: 'emerald' | 'gold' }> = group;

// Read-only use is the common case in a UI, and must not require the setter.
export const leafIsReadable: ReadonlyObservableLike<number> = leaf;
