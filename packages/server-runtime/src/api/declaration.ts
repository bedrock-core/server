import type { Declaration } from '../declaration';
import type { Runtime } from '../runtime';
import type { ApiModule, ApiModuleShape } from './types';
import { createModule, type Bindings } from './bindings';

interface Definition {
  readonly module: string;
  readonly shape: ApiModuleShape;
  readonly exports: object;
  readonly path: readonly string[];
}

const definitions = new WeakMap<object, Map<string, Definition>>();

/** An API implementation installed and withdrawn by its owning Runtime. */
export interface ApiDeclaration<T extends object> extends Declaration<T> {
  readonly api: T;
}

/** @internal Attach Builder's checked public entry to its exported implementation objects. */
export function defineApiModule(module: string, shape: ApiModuleShape, exports: object): void {
  const objects = [{ value: exports, path: [] as string[] }, ...Object.entries(shape.members).flatMap(([name, member]) => {
    const value: unknown = Reflect.get(exports, name);

    return member.kind === 'object' && typeof value === 'object' && value !== null ? [{ value, path: [name] }] : [];
  })];

  for (const object of objects) {
    let entries = definitions.get(object.value);

    if (!entries) {
      entries = new Map();
      definitions.set(object.value, entries);
    }

    entries.set(module, { module, shape, exports, path: object.path });
  }
}

/** @internal Prepare a generated library factory's per-Runtime implementation. */
export function defineApiDeclaration<T extends object>(module: string, shape: ApiModuleShape, declaration: ApiDeclaration<T>): ApiDeclaration<T> {
  const entries = definitions.get(declaration.api) ?? new Map<string, Definition>();

  entries.set(module, { module, shape, exports: declaration.api, path: [] });
  definitions.set(declaration.api, entries);

  return declaration;
}

/** Resolve the same checked API contract in another owning addon. */
export function createApiView<T extends object>(bindings: Bindings, namespace: string, api: T): ApiModule<T> {
  const definition = definitions.get(api)?.values().next().value;

  if (!definition) { throw new Error('API object has no generated contract'); }

  let view: unknown = createModule(bindings, namespace, definition.module, definition.shape);

  for (const name of definition.path) {
    if (typeof view !== 'object' || view === null) { throw new Error('Invalid generated API object path'); }

    view = Reflect.get(view, name);
  }

  // Builder checked the object type and its path in the declared module.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return view as ApiModule<T>;
}

/** Publish an exported API object through core.register(); stopping Core withdraws its entries. */
export function registerApi<T extends object>(api: T): ApiDeclaration<T> {
  let owner: Runtime | undefined;
  const releases: (() => void)[] = [];

  const stop = (): void => {
    const failures: unknown[] = [];

    for (const release of releases.splice(0).reverse()) {
      try { release(); } catch (error) { failures.push(error); }
    }

    owner = undefined;

    if (failures.length) { throw new AggregateError(failures, 'API declaration cleanup failed'); }
  };

  return {
    api,
    install(core): T {
      if (owner) { throw new Error('API declaration is already installed'); }

      const entries = definitions.get(api);

      if (!entries?.size) {
        throw new Error('registerApi() requires a generated contract from a Builder public API entry or library factory');
      }

      owner = core;

      try {
        for (const entry of entries.values()) {
          releases.push(core.api.provideModule(entry.module, entry.shape, entry.exports));
        }
      } catch (error) {
        try { stop(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'API installation and cleanup failed', { cause: cleanupError });
        }

        throw error;
      }

      return api;
    },
    stop,
  };
}
