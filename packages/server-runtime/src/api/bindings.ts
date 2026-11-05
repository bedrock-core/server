import { effect, observable, type Observable, type Unsubscribe } from '@bedrock-core/observable';
import { cloneData, freezeData } from '@bedrock-core/sync/data';
import type { SyncNode } from '@bedrock-core/sync';
import type { Registry } from '../registry';
import type { ApiCallShape, ApiModule, ApiModuleShape, ApiObjectAddress, ApiShape } from './types';
import { freezeApiData, transformData, type ApiDataContext } from './codec';

/** The implementation of one declared public module in this script pack. */
export interface ApiDefinition {
  shape: ApiModuleShape;
  exports: unknown;
  release?: Unsubscribe;
  reference?: ApiObjectAddress;
  onRelease?(): void;
}

export interface ApiConnection {
  data: ApiDataContext;
  node: SyncNode;
  registry: Registry;
  call(namespace: string, module: string, path: readonly string[], args: unknown[], shape: ApiCallShape, reference?: ApiObjectAddress): Promise<unknown>;
  bind(module: string, definition: ApiDefinition): void;
}

/** Generated declarations stay engine-free until the owning Runtime registers. */
export interface Bindings {
  modules: Map<string, ApiDefinition>;
  connection: Observable<ApiConnection | undefined>;
  subscriptions: Set<Unsubscribe>;
  stopping: boolean;
  connect?(): void;
}

export function createBindings(): Bindings {
  return { modules: new Map(), connection: observable<ApiConnection | undefined>(undefined), subscriptions: new Set(), stopping: false };
}

export const defaultBindings = createBindings();

/** Shared addressing for the existing RPC, state and event channels. */
export function memberKey(module: string, path: readonly string[]): string {
  return JSON.stringify(['api', module, ...path]);
}

export function objectModule(address: ApiObjectAddress): string {
  return JSON.stringify(['object', address.instance, address.id]);
}

export function objectAvailable(connection: ApiConnection, address: ApiObjectAddress): boolean {
  return connection.registry.get(address.owner)?.instanceId === address.instance
    && connection.node.state.get(address.owner, memberKey(objectModule(address), [])) !== false;
}

function own(bindings: Bindings, release: Unsubscribe): Unsubscribe {
  let active = true;

  const stop = (): void => {
    if (!active) { return; }

    active = false;
    bindings.subscriptions.delete(stop);
    release();
  };

  bindings.subscriptions.add(stop);

  return stop;
}

/** Materialize ordinary imports without loading the provider implementation or the engine. */
export function createModule<T>(bindings: Bindings, namespace: string, module: string, shape: ApiModuleShape, reference?: ApiObjectAddress): ApiModule<T> {
  const connection = (): ApiConnection | undefined => {
    bindings.connect?.();

    return bindings.connection.get();
  };

  const materialize = (member: ApiShape, path: readonly string[]): unknown => {
    if (member.kind === 'value') { return freezeData(cloneData(member.value)); }

    if (member.kind === 'local') { return member.value; }

    if (member.kind === 'object') {
      return Object.freeze(Object.fromEntries(Object.entries(member.members).map(([name, value]) => [name, materialize(value, [...path, name])])));
    }

    if (member.kind === 'function') {
      return (...args: unknown[]): Promise<unknown> => bindings.stopping
        ? Promise.reject(new Error('API object is unavailable'))
        : connection()?.call(namespace, module, path, args, member, reference)
          ?? Promise.reject(new Error('runtime is unavailable: call register() before using addon APIs'));
    }

    const key = memberKey(module, path);

    const available = (): boolean => {
      const current = connection();

      return !bindings.stopping && current !== undefined && (reference === undefined ? current.registry.get(namespace)?.apis.includes(module) === true : objectAvailable(current, reference));
    };

    if (member.kind === 'event') {
      return Object.freeze({ subscribe: (listener: (payload: unknown) => void): Unsubscribe => {
        if (bindings.stopping) { return (): void => {}; }

        connection();

        let release = (): void => {};

        const follow = (): void => {
          release();
          const current = connection();

          release = current?.node.events.on(namespace, key, (payload) => {
            if (available()) { listener(freezeApiData(transformData(payload, member.data, 'decode', current.data), member.data)); }
          }) ?? ((): void => {});
        };

        const disconnect = bindings.connection.subscribe(follow);

        follow();

        return own(bindings, () => { disconnect(); release(); });
      } });
    }

    let source: ApiConnection | undefined;
    let raw: unknown;
    let decoded: unknown;

    const read = (): unknown => {
      const current = connection();

      if (!available() || current === undefined) {
        source = undefined;
        raw = decoded = undefined;

        return undefined;
      }

      const value = current.node.state.get(namespace, key);

      if (member.data === undefined) { return freezeData(value); }

      if (source !== current || !Object.is(raw, value)) {
        source = current;
        raw = value;
        decoded = freezeApiData(transformData(value, member.data, 'decode', current.data), member.data);
      }

      return decoded;
    };

    return Object.freeze({ get: read, subscribe: (listener: (next: unknown, previous: unknown) => void): Unsubscribe => {
      if (bindings.stopping) { return (): void => {}; }

      let previous = read();

      let release = (): void => {};

      const update = (): void => {
        const next = read();

        if (Object.is(next, previous)) { return; }

        const old = previous;

        previous = next;
        listener(next, old);
      };

      const follow = (): void => {
        release();
        const current = connection();

        release = current === undefined ? (): void => {} : effect(update, [current.node.state.observe(namespace, key), current.registry.addons]);
        update();
      };

      const disconnect = bindings.connection.subscribe(follow);

      follow();

      return own(bindings, () => { disconnect(); release(); });
    } });
  };

  // Builder checked the declared export types before generating this module.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return materialize(shape, []) as ApiModule<T>;
}

/** Register authored exports now or with the owning Runtime. */
export function provideModule(bindings: Bindings, module: string, shape: ApiModuleShape, exports: unknown): Unsubscribe {
  if (bindings.stopping) { throw new Error('runtime is stopping'); }

  if (bindings.modules.has(module)) { throw new Error(`'${module}' is already provided`); }

  const definition: ApiDefinition = { shape, exports };

  bindings.modules.set(module, definition);

  try { bindings.connection.get()?.bind(module, definition); } catch (error) {
    bindings.modules.delete(module);

    throw error;
  }

  return (): void => {
    if (bindings.modules.get(module) !== definition) { return; }

    bindings.modules.delete(module);
    definition.release?.();
  };
}
