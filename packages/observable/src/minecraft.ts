/**
 * The bridge to Minecraft's data-driven UI observables — the only file in this package that
 * imports `@minecraft/server-ui`.
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
import { ObservableBoolean, ObservableNumber, ObservableString } from '@minecraft/server-ui';
import { bindNative, type NativeBinding, type NativeObservable, type NativeScalar, type ToNativeOptions } from './native';
import type { ReadonlyObservable } from './observable';

export { bindNative } from './native';
export type { NativeBinding, NativeObservable, NativeScalar, ToNativeOptions } from './native';

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
