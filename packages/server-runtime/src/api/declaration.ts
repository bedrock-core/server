import type { Declaration, Installation } from '../library';
import type { ApiModule, ApiModuleShape } from './types';
import { createModule, type Bindings } from './bindings';

interface Definition {
  readonly module: string;
  readonly shape: ApiModuleShape;
  readonly exports: object;
  readonly path: readonly string[];
}

const definitions = new WeakMap<object, Map<string, Definition>>();

/** The API library compiler recognizes this checked declaration identity. */
interface ApiDeclaration<T extends object> extends Declaration<T> {
  readonly api: T;
}

/** An API implementation installed and withdrawn by its owning Runtime. */
export type ModuleDeclaration<T extends object> = ApiDeclaration<T>;

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
export function defineApiDeclaration<T extends object>(module: string, shape: ApiModuleShape, declaration: ModuleDeclaration<T>): ModuleDeclaration<T> {
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
export function registerModule<T extends object>(api: T): ModuleDeclaration<T> {
  return {
    api,
    install(core, lifetime): Installation<T> {
      const entries = definitions.get(api);

      if (!entries?.size) {
        throw new Error('registerModule() requires a generated contract from a Builder public API entry or library factory');
      }

      for (const entry of entries.values()) {
        lifetime.defer(core.api.provideModule(entry.module, entry.shape, entry.exports));
      }

      return { value: api };
    },
  };
}
