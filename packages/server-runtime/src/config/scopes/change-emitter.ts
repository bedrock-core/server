import type { Unsubscribe } from '@bedrock-core/sync';

/**
 * A path-change listener, and the same signature `@bedrock-core/observable` uses. That is what
 * makes a config node an observable structurally — `useObservable(config.server.taxRate)` reads a
 * leaf the way it reads any other observable — without either package importing the other. The
 * contract is pinned by `__type-tests__/leaves-are-observables.ts`.
 *
 * `prev` is a value, not `value | undefined`: a change is only emitted for a path that already had
 * one, reconstructed from the previous flat values.
 *
 * Declared through the "bivariance hack" so a listener typed for a specific reconstructed value
 * (e.g. `ChangeListener<SchemaToValue<S>>`) is assignable to the emitter's `ChangeListener<unknown>`
 * storage: the scopes' public overloads pick the value type, while the emitter itself only ever
 * sees `unknown`.
 */
export type ChangeListener<V = unknown> = {
  bivarianceHack(next: V, prev: V): void;
}['bivarianceHack'];

export class ChangeEmitter {
  private readonly _listeners = new Map<string, Set<ChangeListener>>();

  on(path: string, fn: ChangeListener): Unsubscribe {
    let set = this._listeners.get(path);

    if (!set) { set = new Set(); this._listeners.set(path, set); }

    set.add(fn);

    return () => { this._listeners.get(path)?.delete(fn); };
  }

  emit(path: string, next: unknown, prev: unknown): void {
    this._listeners.get(path)?.forEach(fn => fn(next, prev));
  }

  has(path: string): boolean {
    return (this._listeners.get(path)?.size ?? 0) > 0;
  }

  hasAny(): boolean {
    return this._listeners.size > 0;
  }

  clear(): void {
    this._listeners.clear();
  }
}
