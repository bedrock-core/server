/**
 * `last` — the most recent payload of an event, as an observable.
 *
 * An event is a stream of happenings; an observable is a value. The one-line bridge between them
 * is "the last thing that happened": `undefined` until the first event, then each payload as it
 * arrives, so the rest of the system — `computed`, `effect`, a UI hook, a shared key — can treat
 * an engine event or an addon event as a value it watches.
 *
 * It takes anything with `subscribe`: the engine's signals, whose `subscribe` hands the callback
 * back and whose `unsubscribe(cb)` releases it, and the framework's own, whose `subscribe` hands
 * back a release function. Nothing here imports either.
 *
 * It subscribes when created, not when first watched — a value that skipped events while nobody
 * was listening would be wrong — so `dispose()` is what ends it. Use it on `afterEvents` and
 * script events; a `beforeEvents` handler runs inside the engine's read-only window, and a
 * listener notified from there would be handed that window.
 */
import { ObservableImpl, type ObservableOptions, type ReadonlyObservable, type Unsubscribe } from './observable';

/**
 * A source of events, in either shape: `subscribe` returns a release function, or it returns the
 * callback and `unsubscribe(callback)` releases it.
 */
export interface Signal<E, O = never> {
  subscribe(callback: (event: E) => void, options?: O): unknown;
  unsubscribe?(callback: (event: E) => void): void;
}

export interface Last<E> extends ReadonlyObservable<E | undefined> {
  /** Stop following the signal. The last value stays readable. */
  dispose(): void;
}

export function last<E, O = never>(signal: Signal<E, O>, options?: ObservableOptions<E | undefined> & { on?: O }): Last<E> {
  const inner = new ObservableImpl<E | undefined>(undefined, options);

  const callback = (event: E): void => { inner.set(event); };

  const returned = signal.subscribe(callback, options?.on);

  let disposed = false;

  const dispose: Unsubscribe = (): void => {
    if (disposed) { return; }

    disposed = true;

    // The engine hands the callback itself back; the framework hands back a release function. Both
    // are functions, so identity is what tells them apart.
    if (returned === callback) {
      signal.unsubscribe?.(callback);
    } else if (typeof returned === 'function') {
      (returned as Unsubscribe)(); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
    } else {
      signal.unsubscribe?.(callback);
    }
  };

  return {
    get: () => inner.get(),
    subscribe: listener => inner.subscribe(listener),
    dispose,
  };
}
