import { effect } from '@bedrock-core/observable';
import { createBindings, createModule, memberKey, objectModule, type ApiConnection, type ApiDefinition, type Bindings } from './bindings';
import type { ApiObjectAddress, ApiReferenceShape } from './types';
import type { SyncNode } from '@bedrock-core/sync';
import type { Registry } from '../registry';
import { isRecord } from '../guards';

type ObjectShape = Extract<ApiReferenceShape, { reference: 'api' }>;
interface Owned { address: ApiObjectAddress; value: object; definition: ApiDefinition }
// Remote handles can be forwarded through another connection in the same realm.
const addresses = new WeakMap<object, { address: ApiObjectAddress; active(): boolean }>();
const remoteObjects = new WeakMap<SyncNode, Map<string, object>>();

/** Object identity and disposal reuse Runtime bindings and the existing transport services. */
export function createObjectReferences(node: SyncNode, registry: Registry, bindings: Bindings, bind: (module: string, definition: ApiDefinition) => void): {
  encode(value: unknown, shape: ObjectShape): ApiObjectAddress;
  decode(value: unknown, shape: ObjectShape): unknown;
  release(value: object): boolean;
  stop(): void;
} {
  const owned = new Map<string, Owned>();
  const identities = new WeakMap<object, Owned>();
  const released = new WeakSet<object>();
  const remote = new Map<string, { value: object; close(): void }>();
  let sequence = 0;
  let stopped = false;

  const gone = (address: ApiObjectAddress, connection = bindings.connection.get()): boolean => {
    const owner = (connection?.registry ?? registry).get(address.owner);

    return stopped || (owner !== undefined && owner.instanceId !== address.instance)
      || (connection?.node ?? node).state.get(address.owner, memberKey(objectModule(address), [])) === false;
  };

  const release = (value: object): boolean => {
    if (addresses.has(value)) { throw new Error('only the owning addon can release an API object'); }

    const entry = identities.get(value);

    if (entry === undefined) { return false; }

    released.add(value);
    entry.definition.release?.();

    return true;
  };

  return {
    encode(value, shape): ApiObjectAddress {
      if (stopped) { throw new Error('runtime stopped'); }

      if (!isRecord(value) || Array.isArray(value)) { throw new TypeError('expected an API object'); }

      if (released.has(value)) { throw new Error('API object was released'); }

      const remoteAddress = addresses.get(value);

      if (remoteAddress !== undefined) {
        const { address } = remoteAddress;

        if (!remoteAddress.active() || gone(address)) { throw new Error('API object is unavailable'); }

        if (address.contract !== shape.contract) { throw new TypeError('API object contract does not match'); }

        return address;
      }

      const existing = identities.get(value);

      if (existing !== undefined) {
        if (existing.address.contract !== shape.contract) { throw new TypeError('an API object has one public contract'); }

        return existing.address;
      }

      const created = Object.freeze({ owner: node.id, instance: node.bus.instanceId, id: String(++sequence), contract: shape.contract });
      const definition: ApiDefinition = { shape: shape.shape, exports: value, reference: created, onRelease() {
        owned.delete(created.id);
        identities.delete(value);
        node.state.set(node.id, memberKey(objectModule(created), []), false);
      } };
      const entry = { address: created, value, definition };

      owned.set(created.id, entry);
      identities.set(value, entry);

      try {
        bind(objectModule(created), definition);
        node.state.set(node.id, memberKey(objectModule(created), []), true);
      } catch (error) {
        owned.delete(created.id);
        identities.delete(value);
        definition.release?.();

        throw error;
      }

      return created;
    },
    decode(value, shape): unknown {
      if (!isRecord(value) || typeof value.owner !== 'string' || !value.owner || typeof value.instance !== 'string' || !value.instance
        || typeof value.id !== 'string' || !value.id || value.contract !== shape.contract) { throw new TypeError('invalid API object reference'); }

      const address: ApiObjectAddress = Object.freeze({ owner: value.owner, instance: value.instance, id: value.id, contract: shape.contract });

      if (gone(address)) { return undefined; }

      if (address.owner === node.id) {
        if (address.instance !== node.bus.instanceId) { return undefined; }

        const entry = owned.get(address.id);

        return entry?.address.contract === address.contract ? entry.value : undefined;
      }

      const key = JSON.stringify(address);
      const existing = remote.get(key)?.value ?? remoteObjects.get(bindings.connection.get()?.node ?? node)?.get(key);

      if (existing !== undefined) { return existing; }

      const scope = createBindings();

      scope.connect = (): void => bindings.connect?.();
      const proxy = createModule<object>(scope, address.owner, objectModule(address), shape.shape, address);

      let disconnect = (): void => {};

      let stop = (): void => {};

      let cache: Map<string, object> | undefined;
      let closed = false;

      const close = (): void => {
        if (closed) { return; }

        closed = true;
        scope.stopping = true;
        released.add(proxy);
        const failures: unknown[] = [];

        for (const cleanup of [(): void => { scope.connection.set(undefined); }, disconnect, ...scope.subscriptions, stop]) {
          try { cleanup(); } catch (error) { failures.push(error); }
        }

        bindings.subscriptions.delete(close);
        remote.delete(key);

        if (cache?.get(key) === proxy) { cache.delete(key); }

        if (failures.length) { throw new AggregateError(failures, 'API object listener cleanup failed'); }
      };

      remote.set(key, { value: proxy, close });
      addresses.set(proxy, { address, active: (): boolean => !closed });
      bindings.subscriptions.add(close);

      const follow = (): void => {
        stop();

        stop = (): void => {};

        if (cache?.get(key) === proxy) { cache.delete(key); }

        cache = undefined;
        const connection: ApiConnection | undefined = bindings.connection.get();

        scope.connection.set(connection);

        if (closed || connection === undefined) { return; }

        cache = remoteObjects.get(connection.node);

        if (cache === undefined) {
          cache = new Map();
          remoteObjects.set(connection.node, cache);
        }

        if (!cache.has(key)) { cache.set(key, proxy); }

        let seen = false;
        const release = effect(() => {
          const owner = connection.registry.get(address.owner);

          if (owner?.instanceId === address.instance) { seen = true; }

          if (gone(address, connection) || (seen && owner === undefined)) { close(); }
        }, [connection.registry.addons, connection.node.state.observe(address.owner, memberKey(objectModule(address), []))]);

        if (closed) { release(); } else { stop = release; }
      };

      disconnect = bindings.connection.subscribe(follow);
      follow();

      return proxy;
    },
    release,
    stop(): void {
      const failures: unknown[] = [];

      for (const entry of [...owned.values()]) {
        try { release(entry.value); } catch (error) { failures.push(error); }
      }

      for (const entry of [...remote.values()]) {
        try { entry.close(); } catch (error) { failures.push(error); }
      }

      stopped = true;

      if (failures.length) { throw new AggregateError(failures, 'API reference cleanup failed'); }
    },
  };
}
