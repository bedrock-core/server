import {
  ObservableImpl,
  type ObservableOptions,
  type ReadonlyObservable,
  type Unsubscribe,
} from './observable';

/** Schedule one deferred callback and return a function that cancels it. The caller owns the delay. */
export type DebounceScheduler = (callback: () => void) => Unsubscribe;

/** A read-only value that publishes source changes after a quiet period. */
export interface Debounced<T> extends ReadonlyObservable<T> {
  /** Cancel pending delivery and stop following the source. The last published value stays readable. */
  dispose(): void;
}

/**
 * Start with `source.get()`, then publish only the latest change once `schedule` runs its callback.
 * Each source notification cancels and replaces the pending callback. `get()` keeps the last
 * published value until delivery; `prev` is that value, not an intermediate source value.
 *
 * Subscribes eagerly. The scheduler must defer delivery and return a non-throwing cancellation
 * function. It can use Minecraft ticks or a host timer without adding an engine dependency here.
 * Equality and listener error reporting use the same options as `observable()`.
 */
export function debounce<T>(
  source: ReadonlyObservable<T>,
  schedule: DebounceScheduler,
  options?: ObservableOptions<T>,
): Debounced<T> {
  const inner = new ObservableImpl(source.get(), options);
  let pending: { cancel?: Unsubscribe } | undefined;
  let disposed = false;

  const cancelPending = (): void => {
    const task = pending;

    pending = undefined;
    task?.cancel?.();
  };

  const unsubscribe = source.subscribe((next) => {
    if (disposed) {
      return;
    }

    cancelPending();

    const task: { cancel?: Unsubscribe } = {};

    pending = task;

    try {
      task.cancel = schedule(() => {
        if (disposed || pending !== task) {
          return;
        }

        pending = undefined;
        inner.set(() => next);
      });
    } catch (error) {
      if (pending === task) {
        pending = undefined;
      }

      throw error;
    }
  });

  return {
    get: () => inner.get(),
    subscribe: listener => inner.subscribe(listener),
    dispose: (): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribe();
      cancelPending();
    },
  };
}
