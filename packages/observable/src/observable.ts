/**
 * The observable itself: a value with `get` / `set` / `subscribe`.
 *
 * Values are immutable — `set` replaces, and a store of an object gets a new object — which is
 * what makes `equals` a cheap `Object.is` by default and lets `computed` trust it. Listeners are
 * isolated: one that throws is reported and skipped, the rest still run, so one addon's bug does
 * not silence another's subscription.
 */
import { enqueue, isBatching, type Flushable } from './batch';

/** What `subscribe` returns: call it to stop listening. */
export type Unsubscribe = () => void;

/** Told the new value and the one before it. */
export type Listener<T> = (next: T, prev: T) => void;

/** Whether two values count as the same, so a `set` to an equal value notifies nobody. */
export type Equals<T> = (a: T, b: T) => boolean;

/** What anything exposing a value it owns hands out: readable, watchable, not writable. */
export interface ReadonlyObservable<T> {
  get(): T;
  subscribe(listener: Listener<T>): Unsubscribe;
}

/** A value with the three verbs: read it, replace it, watch it. */
export interface Observable<T> extends ReadonlyObservable<T> {
  /** Replace the value. An updater receives the current value. Notifies unless `equals` says nothing changed. */
  set(next: T | ((prev: T) => T)): void;
}

/** What `observable()` and the derived forms take beside the value. */
export interface ObservableOptions<T> {
  /** Defaults to `Object.is`. */
  equals?: Equals<T>;
  /** Names the observable in the log line a throwing listener produces. */
  label?: string;
}

/** The one log line a throwing listener produces, naming the observable when it has a label. */
export function reportListenerError(label: string | undefined, error: unknown): void {
  console.error(`[observable]${label ? ` ${label}:` : ''} listener threw`, error);
}

/**
 * `set` accepts a value or an updater. An observable whose value type is itself a function
 * cannot be told apart from an updater here; wrap such a value in an updater that returns it.
 */
function isUpdater<T>(next: T | ((prev: T) => T)): next is (prev: T) => T {
  return typeof next === 'function';
}

/**
 * The observable behind `observable()`, `computed()` and `last()`: synchronous delivery, `equals`
 * gating, listener isolation, and deferral inside a batch.
 */
export class ObservableImpl<T> implements Observable<T>, Flushable {
  private readonly _equals: Equals<T>;
  private readonly _label: string | undefined;
  // Copy-on-write: subscribe and unsubscribe replace the array, so delivery iterates a stable
  // reference with no per-set allocation, and a listener removed mid-delivery is still safe.
  private _listeners: readonly Listener<T>[] = [];
  private _value: T;
  private _batchPrev: T;
  private _queued = false;

  constructor(initial: T, options?: ObservableOptions<T>) {
    this._value = initial;
    this._batchPrev = initial;
    this._equals = options?.equals ?? Object.is;
    this._label = options?.label;
  }

  get(): T {
    return this._value;
  }

  set(next: T | ((prev: T) => T)): void {
    const value = isUpdater(next) ? next(this._value) : next;

    if (this._equals(this._value, value)) {
      return;
    }

    const prev = this._value;

    this._value = value;

    if (isBatching()) {
      // Remember the value listeners last saw; the flush compares against that, so a value
      // that changes and changes back inside one batch produces no notification at all.
      if (!this._queued) {
        this._queued = true;
        this._batchPrev = prev;
        enqueue(this);
      }

      return;
    }

    this._notify(value, prev);
  }

  subscribe(listener: Listener<T>): Unsubscribe {
    this._listeners = [...this._listeners, listener];

    return (): void => {
      const index = this._listeners.indexOf(listener);

      if (index >= 0) {
        this._listeners = [...this._listeners.slice(0, index), ...this._listeners.slice(index + 1)];
      }
    };
  }

  flush(): void {
    this._queued = false;

    const prev = this._batchPrev;

    if (this._equals(this._value, prev)) {
      return;
    }

    this._notify(this._value, prev);
  }

  private _notify(next: T, prev: T): void {
    const listeners = this._listeners;

    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](next, prev);
      } catch (error) {
        reportListenerError(this._label, error);
      }
    }
  }
}

/** A value with `get`, `set` and `subscribe`, delivering synchronously to isolated listeners. */
export function observable<T>(initial: T, options?: ObservableOptions<T>): Observable<T> {
  return new ObservableImpl(initial, options);
}
