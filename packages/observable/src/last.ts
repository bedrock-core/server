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
import type { Signal } from './signal';
import { toSignal, type NativeSignal } from './native';

/** What `last()` returns: the most recent payload, `undefined` before the first, and a way to stop. */
export interface Last<E> extends ReadonlyObservable<E | undefined> {
  /** Stop following the signal. The last value stays readable. */
  dispose(): void;
}

/**
 * An event as a value: the most recent payload of `signal`, `undefined` before the first. Eager —
 * the subscription is taken now — and released with `dispose()`. `options.on` is handed to
 * `subscribe` as its second argument, for a signal that filters.
 */
export function last<E, O = never>(signal: Signal<E> | NativeSignal<E, O>, options?: ObservableOptions<E | undefined> & { on?: O }): Last<E> {
  const inner = new ObservableImpl<E | undefined>(undefined, options);

  const callback = (event: E): void => { inner.set(event); };

  const release = ('unsubscribe' in signal ? toSignal(signal, options?.on) : signal).subscribe(callback);
  let disposed = false;

  const dispose: Unsubscribe = (): void => {
    if (disposed) { return; }

    disposed = true;
    release();
  };

  return {
    get: () => inner.get(),
    subscribe: listener => inner.subscribe(listener),
    dispose,
  };
}
