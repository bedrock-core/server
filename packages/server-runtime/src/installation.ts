import type { Declaration, Installation, InstallationLifetime } from './library';
import type { Runtime } from './runtime';
import type { Registries } from './registries/registry';

const registries = new WeakMap<Runtime, Registries>();

/** @internal Attach library installation to the registered Runtime's private registry storage. */
export function attachRegistry(runtime: Runtime, registry: Registries): void {
  registries.set(runtime, registry);
}

/** @internal Remove the installation context before the Runtime is taken offline. */
export function detachRegistry(runtime: Runtime): void {
  registries.delete(runtime);
}

/** @internal Library declarations use the registry without exposing a Core registry directory. */
export function registryOf(runtime: Runtime): Registries {
  const registry = registries.get(runtime);

  if (registry === undefined) { throw new Error('registry installation requires a registered runtime'); }

  return registry;
}

/** @internal Owns the resources acquired by one installation, including partial setup. */
export class InstallationScope implements InstallationLifetime {
  private readonly _stops: (() => void)[] = [];
  private readonly _children: (() => void)[] = [];
  private _stop: (() => void) | undefined;
  private _stopped = false;

  get stopped(): boolean { return this._stopped; }

  defer(stop: () => void): void {
    if (this._stopped) { throw new Error('library installation is stopped'); }

    this._stops.push(stop);
  }

  attach(stop: () => void): void {
    if (this._stopped) { throw new Error('library installation is stopped'); }

    this._children.push(stop);
  }

  own<T>(result: Installation<T>): T {
    if (result === null || typeof result !== 'object' || !Object.hasOwn(result, 'value')
      || (result.stop !== undefined && typeof result.stop !== 'function')) {
      throw new TypeError('library installation must return { value, stop? }');
    }

    if (this._stopped) {
      result.stop?.();
      throw new Error('library installation stopped during setup');
    }

    this._stop = result.stop;

    return result.value;
  }

  stop(): void {
    if (this._stopped) { return; }

    this._stopped = true;
    const failures: unknown[] = [];

    const stops = [...this._children.splice(0).reverse(), ...this._stop === undefined ? [] : [this._stop], ...this._stops.splice(0).reverse()];

    this._stop = undefined;

    for (const stop of stops) {
      try { stop(); } catch (error) { failures.push(error); }
    }

    if (failures.length) { throw new AggregateError(failures, 'library cleanup failed'); }
  }
}

/** Whether a registration field contains a library recipe. */
export function isDeclaration(value: unknown): value is Declaration<unknown> {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { install?: unknown }).install === 'function';
}
