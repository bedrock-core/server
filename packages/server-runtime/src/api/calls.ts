import { system } from '@minecraft/server';
import type { SyncNode } from '@bedrock-core/sync';
import type { Registry } from '../registry';
import type { ApiConnection, Bindings } from './bindings';
import { memberKey } from './bindings';
import { decodeArguments, encodeArguments, transformData, type ApiDataContext, type CallCallbacks } from './codec';
import type { ApiCallShape, ApiObjectAddress } from './types';
import { isRecord } from '../guards';

/** Shared outbound API calls and call-scoped callbacks over the existing Sync services. */
export function createApiCalls(node: SyncNode, registry: Registry, bindings: Bindings, data: ApiDataContext, running: () => boolean): {
  call: ApiConnection['call'];
  callbacks(target: string, instance: string | undefined, active: () => boolean): CallCallbacks & { close(): void };
} {
  let sequence = 0;

  const callbacks = (target: string, instance: string | undefined, active: () => boolean): CallCallbacks & { close(): void } => {
    const releases: (() => void)[] = [];
    let closed = false;

    const close = (): void => {
      if (closed) { return; }

      closed = true;
      bindings.subscriptions.delete(close);

      for (const release of releases.splice(0)) { release(); }
    };

    const check = (expires: number): void => {
      const current = target === node.id ? node.bus.instanceId : node.discovery.getPeer(target)?.instanceId;

      if (closed || !running() || !active() || current !== instance || system.currentTick >= expires) { throw new Error('API callback call has ended'); }
    };

    return {
      close,
      encode: (fn, shape): unknown => {
        const expires = system.currentTick + node.rpc.defaultTimeoutTicks;
        const method = JSON.stringify(['api-callback', node.bus.instanceId, ++sequence]);

        check(expires);
        releases.push(node.rpc.onRequest(method, (params, from) => {
          check(expires);

          if (from !== target) { throw new Error('API callback belongs to another call'); }

          const result = fn(...decodeArguments(params, shape.parameters, data));

          if (!(result instanceof Promise)) { throw new TypeError('API callbacks must return a Promise'); }

          return result.then((value: unknown): unknown => {
            check(expires);

            return transformData(value, shape.result, 'encode', data);
          });
        }));
        bindings.subscriptions.add(close);

        return { owner: node.id, instance: node.bus.instanceId, method, expires };
      },
      decode: (value, shape): ((...args: unknown[]) => Promise<unknown>) => {
        if (!isRecord(value) || value.owner !== target || value.instance !== instance || typeof value.method !== 'string'
          || typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires) || instance === undefined) {
          throw new TypeError('invalid API callback reference');
        }

        const { method, expires } = value;

        return async (...args: unknown[]): Promise<unknown> => {
          check(expires);
          const result = await node.rpc.request(target, method, encodeArguments(args, shape.parameters, data), {
            instanceId: instance, timeoutTicks: Math.max(1, expires - system.currentTick),
          });

          check(expires);

          return transformData(result, shape.result, 'decode', data);
        };
      },
    };
  };

  return {
    callbacks,
    async call(namespace: string, module: string, path: readonly string[], args: unknown[], shape: ApiCallShape, reference?: ApiObjectAddress): Promise<unknown> {
      const addon = reference === undefined ? await registry.whenApi(namespace, module) : await registry.whenInstance(namespace, reference.instance);

      if (reference !== undefined && node.state.get(namespace, memberKey(module, [])) === false) { throw new Error('API object was released'); }

      if (!running()) { throw new Error('runtime stopped'); }

      const active = (): boolean => running() && registry.get(namespace)?.instanceId === addon.instanceId;
      const callCallbacks = shape.parameters === undefined ? undefined : callbacks(namespace, addon.instanceId, active);
      const context = callCallbacks === undefined ? data : { ...data, callbacks: callCallbacks };

      try {
        const value = await node.rpc.request(namespace, memberKey(module, path), encodeArguments(args, shape.parameters, context), { instanceId: addon.instanceId });

        if (!running()) { throw new Error('runtime stopped'); }

        if (!active()) { throw new Error(`'${namespace}' stopped`); }

        return transformData(value, shape.result, 'decode', data);
      } finally {
        callCallbacks?.close();
      }
    },
  };
}
