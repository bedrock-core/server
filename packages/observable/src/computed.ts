/**
 * `computed` and `effect` — the two things built on an observable's subscription.
 *
 * Dependencies are listed, never tracked: a `Proxy` trap on every property read of every tick is
 * the cost the config accessor tree already refused to pay, and the same reasoning holds here.
 * Inside a batch either one runs once at flush however many dependencies changed.
 */
import { coalesced } from './batch';
import {
  ObservableImpl,
  reportListenerError,
  type ObservableOptions,
  type ReadonlyObservable,
  type Unsubscribe,
} from './observable';

export interface Computed<T> extends ReadonlyObservable<T> {
  /** Stop following the dependencies. The last value stays readable. */
  dispose(): void;
}

function follow(deps: readonly ReadonlyObservable<unknown>[], onChange: () => void): Unsubscribe {
  const unsubscribes = deps.map(dep => dep.subscribe(onChange));

  return (): void => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
}

/**
 * A value derived from other observables, recomputed when any of them changes and notifying only
 * when the result differs. A `compute` that throws is reported and the previous value kept.
 */
export function computed<T>(
  compute: () => T,
  deps: readonly ReadonlyObservable<unknown>[],
  options?: ObservableOptions<T>,
): Computed<T> {
  const inner = new ObservableImpl<T>(compute(), options);

  const recompute = (): void => {
    let next: T;

    try {
      next = compute();
    } catch (error) {
      reportListenerError(options?.label ?? 'computed', error);

      return;
    }

    inner.set(next);
  };

  const dispose = follow(deps, coalesced(recompute));

  return {
    get: () => inner.get(),
    subscribe: listener => inner.subscribe(listener),
    dispose,
  };
}

/**
 * Run `run` now and again whenever a dependency changes. Returns the unsubscribe. A `run` that
 * throws is reported and the effect stays attached.
 */
export function effect(
  run: () => void,
  deps: readonly ReadonlyObservable<unknown>[],
  options?: { label?: string },
): Unsubscribe {
  const safeRun = (): void => {
    try {
      run();
    } catch (error) {
      reportListenerError(options?.label ?? 'effect', error);
    }
  };

  const dispose = follow(deps, coalesced(safeRun));

  safeRun();

  return dispose;
}
