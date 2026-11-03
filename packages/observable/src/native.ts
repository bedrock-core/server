/**
 * The binding half of the DDUI bridge, written against the shape of the engine's observables
 * rather than the classes, so it needs no engine to run and can be tested with a stub.
 *
 * - ours is the source of truth — every change of ours is pushed into the native;
 * - the native writes back into ours only when `clientWritable` — that is the player moving the
 *   control — and only when the value actually differs, so the two never chase each other;
 * - the returned unsubscribe releases both directions; the native side is released with
 *   `unsubscribe(cb)`, the engine's only release (its `subscribe` returns the callback, not a handle).
 */
import type { Observable, ReadonlyObservable, Unsubscribe } from './observable';
import type { Signal } from './signal';

/** What a native observable can hold. Objects go through `computed` into one of these. */
export type NativeScalar = number | string | boolean;

/** The shape shared by `ObservableNumber`, `ObservableString` and `ObservableBoolean`. */
export interface NativeObservable<T> {
  getData(): T;
  setData(data: T): void;
  /** The engine hands the callback back, not a handle; `unsubscribe` is the release. */
  subscribe(callback: (value: T) => void): unknown;
  unsubscribe(callback: (value: T) => void): boolean;
}

/** How a native observable is bound to one of ours. */
export interface ToNativeOptions {
  /** Let the player's control write the value back. Off, the native is a one-way view. */
  clientWritable?: boolean;
}

/** What `toNative()` returns: the native to hand to a form control, and the release. */
export interface NativeBinding<N> {
  native: N;
  /** Release both directions. Call it when the form closes. */
  dispose: Unsubscribe;
}

function isWritable<T>(source: ReadonlyObservable<T>): source is Observable<T> {
  return 'set' in source && typeof source.set === 'function';
}

/** Keep an existing native observable in step with one of ours. */
export function bindNative<T extends NativeScalar>(
  source: ReadonlyObservable<T>,
  native: NativeObservable<T>,
  options?: ToNativeOptions,
): Unsubscribe {
  const push = (next: T): void => {
    if (!Object.is(native.getData(), next)) {
      native.setData(next);
    }
  };

  push(source.get());

  const unsubscribeOurs = source.subscribe(push);
  let pull: ((value: T) => void) | undefined;

  if (options?.clientWritable && isWritable(source)) {
    pull = (value: T): void => {
      if (!Object.is(source.get(), value)) {
        source.set(value);
      }
    };

    native.subscribe(pull);
  }

  return (): void => {
    unsubscribeOurs();

    if (pull) {
      native.unsubscribe(pull);
    }
  };
}

/** Native event convention: remove the registered callback through unsubscribe. */
export interface NativeSignal<T, Options = never> {
  subscribe(callback: (event: T) => void, options?: Options): ((event: T) => void) | void;
  unsubscribe(callback: (event: T) => void): void;
}

/** Adapt native events to cleanup-return subscriptions. Conversion is lazy and does not replay events. */
export function toSignal<T, Options = never>(source: NativeSignal<T, Options>, options?: Options): Signal<T> {
  return {
    subscribe(callback): Unsubscribe {
      // Each subscription owns its callback, even when callers reuse the same listener.
      const listener = (event: T): void => { callback(event); };

      const registered = source.subscribe(listener, options);
      let active = true;

      return (): void => {
        if (!active) { return; }

        source.unsubscribe(registered ?? listener);
        active = false;
      };
    },
  };
}
