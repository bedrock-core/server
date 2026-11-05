import { SyncNode } from '@bedrock-core/sync';
import { Registry } from '../registry';
import { createBindings, createModule, defaultBindings, type ApiConnection } from './bindings';
import { createApiCalls } from './calls';
import { nativeReferences } from './references';
import { nativeValues } from './native-values';
import { createObjectReferences } from './objects';
import type { ApiDataContext } from './codec';
import type { ApiModule, ApiModuleShape } from './types';

const bindings = createBindings();
let fallback: { connection: ApiConnection; retire(): void; stop(): void } | undefined;
const draining = new Set<() => void>();

const ensure = (): void => {
  if (bindings.stopping) { return; }

  const registered = defaultBindings.connection.get();

  if (registered !== undefined) {
    bindings.connection.set(registered);

    return;
  }

  if (fallback !== undefined) {
    bindings.connection.set(fallback.connection);

    return;
  }

  // This transport endpoint is a consumer, not an advertised addon identity.
  const node = new SyncNode({ id: `api_client_${Math.random().toString(36).slice(2)}` });
  const registry = new Registry(node.discovery);
  const objects = createObjectReferences(node, registry, bindings, () => {
    throw new Error('Providing API objects requires Core registration');
  });
  const data: ApiDataContext = { values: nativeValues, references: {
    encode: (value, shape): unknown => {
      if (shape.reference !== 'api') { return nativeReferences.encode(value, shape.reference, shape.nativeType); }

      const registered = defaultBindings.connection.get()?.data.references;

      return registered === undefined ? objects.encode(value, shape) : registered.encode(value, shape);
    },
    decode: (value, shape): unknown => {
      if (shape.reference !== 'api') { return nativeReferences.decode(value, shape.reference, shape.nativeType); }

      const registered = defaultBindings.connection.get()?.data.references;

      return registered === undefined ? objects.decode(value, shape) : registered.decode(value, shape);
    },
  } };
  let running = true;
  let retired = false;
  let pending = 0;
  const calls = createApiCalls(node, registry, bindings, data, () => running);

  const stopTransport = (): void => {
    if (!running) { return; }

    running = false;
    draining.delete(stop);

    try { registry.stop(); } finally { node.stop(); }
  };

  const stop = (): void => {
    try { objects.stop(); } finally { stopTransport(); }
  };

  const connection: ApiConnection = { node, registry, data, async call(...args): Promise<unknown> {
    pending++;

    try { return await calls.call(...args); } finally {
      pending--;

      if (retired && pending === 0) { stopTransport(); }
    }
  }, bind() { throw new Error('Providing APIs requires Core registration'); } };

  fallback = { connection, stop, retire(): void {
    retired = true;
    draining.add(stop);

    // Replies and call-scoped callbacks keep their original endpoint until settled.
    if (pending === 0) { stopTransport(); }
  } };

  try {
    node.start();
    registry.start();
    bindings.connection.set(connection);
  } catch (error) {
    const previous = fallback;

    fallback = undefined;
    previous.stop();

    throw error;
  }
};

bindings.connect = ensure;
defaultBindings.connection.subscribe((connection) => {
  if (connection === undefined) {
    if (bindings.connection.get() !== fallback?.connection) { bindings.connection.set(undefined); }

    return;
  }

  const previous = fallback;

  fallback = undefined;
  bindings.connection.set(connection);
  previous?.retire();
});

/** @internal Published bindings prefer registered Core or lazily start a shared consumer endpoint. */
export function createClientApiModule<T>(namespace: string, moduleName: string, shape: ApiModuleShape): ApiModule<T> {
  return createModule<T>(bindings, namespace, moduleName, shape);
}

/** @internal Release portable-client subscriptions and its owned transport, preserving registered Core. */
export function stopApiClient(): void {
  bindings.stopping = true;
  const previous = fallback;

  fallback = undefined;
  bindings.connection.set(undefined);
  const failures: unknown[] = [];

  try {
    for (const release of [...bindings.subscriptions, ...draining, (): void => previous?.stop()]) {
      try { release(); } catch (error) { failures.push(error); }
    }
  } finally {
    bindings.subscriptions.clear();
    bindings.stopping = false;
  }

  if (failures.length) { throw new AggregateError(failures, 'API client cleanup failed'); }
}
