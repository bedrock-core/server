/**
 * Minecraft adapters: tick scheduling and the bridge to data-driven UI observables.
 * This entry imports `@minecraft/server` and `@minecraft/server-ui`.
 *
 * A `CustomForm` redraws only for the engine's own `ObservableNumber` / `ObservableString` /
 * `ObservableBoolean`, one scalar each, so ours cannot *be* theirs. `toNative` mints a native
 * one per control and keeps it in step with ours for the form's lifetime; the binding rules are
 * `bindNative`'s, in `./native`.
 *
 * ```ts
 * const { native: volume, dispose } = toNative(config.player.for(p).volume, { clientWritable: true });
 * new CustomForm(p, 'Settings').slider('Volume', volume, 0, 100).show().then(dispose);
 * ```
 */
import { system } from '@minecraft/server';
import { ObservableBoolean, ObservableNumber, ObservableString } from '@minecraft/server-ui';
import type { DebounceScheduler } from './debounce';
import { bindNative, type NativeBinding, type NativeObservable, type NativeScalar, type ToNativeOptions } from './native';
import type { ReadonlyObservable } from './observable';

export { bindNative } from './native';
export type { NativeBinding, NativeObservable, NativeScalar, ToNativeOptions } from './native';

/**
 * A reusable scheduler for `debounce(source, afterTicks(ticks))`. Each call schedules its own
 * `system.runTimeout` and returns a cancellation function backed by `system.clearRun`.
 * `ticks` must be a non-negative safe integer; invalid values throw `RangeError` immediately.
 * Zero uses Minecraft's current-tick/as-soon-as-possible scheduling rather than waiting a tick.
 */
export function afterTicks(ticks: number): DebounceScheduler {
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new RangeError('ticks must be a non-negative safe integer');
  }

  return (callback) => {
    const runId = system.runTimeout(callback, ticks);

    return (): void => system.clearRun(runId);
  };
}

/**
 * Mint the engine's observable for a scalar and keep it in step with `source` for the form's
 * lifetime: ours is the source of truth, the native writes back only when `clientWritable`, and
 * `dispose()` releases both directions.
 */
export function toNative(source: ReadonlyObservable<number>, options?: ToNativeOptions): NativeBinding<ObservableNumber>;
export function toNative(source: ReadonlyObservable<string>, options?: ToNativeOptions): NativeBinding<ObservableString>;
export function toNative(source: ReadonlyObservable<boolean>, options?: ToNativeOptions): NativeBinding<ObservableBoolean>;

export function toNative(
  source: ReadonlyObservable<NativeScalar>,
  options?: ToNativeOptions,
): NativeBinding<NativeObservable<NativeScalar>> {
  const initial = source.get();
  const nativeOptions = { clientWritable: options?.clientWritable ?? false };
  const native: NativeObservable<NativeScalar> = typeof initial === 'number'
    ? new ObservableNumber(initial, nativeOptions)
    : typeof initial === 'string'
      ? new ObservableString(initial, nativeOptions)
      : new ObservableBoolean(initial, nativeOptions);

  return { native, dispose: bindNative(source, native, options) };
}
