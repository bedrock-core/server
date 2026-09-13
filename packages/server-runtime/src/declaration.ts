/**
 * A declaration: something an addon hands to {@link Runtime.register} that installs itself and
 * returns the accessor it is read through.
 *
 * The runtime knows nothing about what a declaration builds. `register()` walks the options bag,
 * installs every declaration it finds in the order the keys were written, and returns each
 * `install` result under the key it was declared as — so a package outside this repository can add
 * a field to `register()` and have its own types come back typed, without the floor importing them.
 *
 * ```ts
 * const { config, shared } = core.register({ manifest, config: config(definition), shared: shared(keys) });
 * ```
 *
 * Lifecycle stays with the runtime: `register()` installs, and `Runtime.stop()` calls `stop?()` on
 * every declaration it installed, so a declaration needs no disposal hook of its own.
 */
import type { Runtime } from './runtime';

/** What a `register()` field holds: an installer returning the accessor, and optional teardown. */
export interface Declaration<T> {
  /** Build the subsystem on `core` and return what the addon reads it through. */
  install(core: Runtime): T;

  /** Release what `install` built. Called by {@link Runtime.stop}. */
  stop?(): void;
}

/** Whether an options value is a declaration — an object with an `install` method. */
export function isDeclaration(value: unknown): value is Declaration<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { install?: unknown }).install === 'function';
}
