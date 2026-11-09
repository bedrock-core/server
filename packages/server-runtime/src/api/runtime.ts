import type { ReadonlyObservable, Signal } from '@bedrock-core/observable';
import type { SyncNode } from '@bedrock-core/sync';
import { cloneData } from '@bedrock-core/sync/data';
import { isRecord } from '../guards';
import type { AddonRegistry } from '../registries/addons';
import { createModule, memberKey, provideModule, type ApiDefinition, type Bindings } from './bindings';
import type { ApiModule, ApiModuleShape, ApiShape } from './types';
import { decodeArguments, transformData, type ApiDataContext } from './codec';
import { nativeReferences } from './references';
import { nativeValues } from './native-values';
import { createObjectReferences } from './objects';
import { createApiCalls } from './calls';
import { createApiView } from './declaration';

function isStateSource(value: unknown): value is ReadonlyObservable<unknown> {
  return isRecord(value) && typeof value.get === 'function' && typeof value.subscribe === 'function';
}

function isEventSource(value: unknown): value is Signal<unknown> {
  return isRecord(value) && typeof value.subscribe === 'function';
}

function sourceAt(root: unknown, path: readonly string[], instance = false): { value: unknown; receiver: unknown } {
  let value = root;
  let receiver: unknown;

  for (const key of path) {
    receiver = value;

    if (!isRecord(value) || !(instance ? key in value : Object.hasOwn(value, key))) { throw new Error(`[addon API] missing export '${path.join('.')}'`); }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (!instance && prototype !== Object.prototype && prototype !== null) { throw new Error('[addon API] nested export objects must be plain objects'); }

    value = value[key];
  }

  return { value, receiver };
}

function eachLeaf(shape: ApiShape, visit: (shape: Exclude<ApiShape, ApiModuleShape>, path: readonly string[]) => void, path: readonly string[] = []): void {
  if (shape.kind !== 'object') {
    visit(shape, path);

    return;
  }

  for (const [name, member] of Object.entries(shape.members)) { eachLeaf(member, visit, [...path, name]); }
}

/** @internal Owns API bindings, subscriptions, calls and reference lifetimes. */
export class RuntimeApi {
  private _node: SyncNode | undefined;
  private _calls: ReturnType<typeof createApiCalls> | undefined;
  private _objects: ReturnType<typeof createObjectReferences> | undefined;
  private readonly _releases: (() => void)[] = [];
  private readonly _apiData: ApiDataContext = { values: nativeValues, references: {
    encode: (value, shape): unknown => shape.reference === 'api'
      ? this._require(this._objects, 'API objects').encode(value, shape)
      : nativeReferences.encode(value, shape.reference, shape.nativeType),
    decode: (value, shape): unknown => shape.reference === 'api'
      ? this._require(this._objects, 'API objects').decode(value, shape)
      : nativeReferences.decode(value, shape.reference, shape.nativeType),
  } };

  /** Public exports and generated imports use the existing runtime channels. */
  readonly api;

  constructor(private readonly _bindings: Bindings, private readonly _changed: () => void) {
    function create<T extends object>(namespace: string, implementation: T): ApiModule<T>;
    /** @internal Generated bindings can supply their checked module shape directly. */
    function create<T>(namespace: string, module: string, shape: ApiModuleShape): ApiModule<T>;

    function create(namespace: string, module: object | string, shape?: ApiModuleShape): unknown {
      if (typeof module !== 'string') { return createApiView(_bindings, namespace, module); }

      if (shape === undefined) { throw new TypeError('generated modules require a checked shape'); }

      return createModule(_bindings, namespace, module, shape);
    }

    this.api = Object.freeze({
      createModule: create,
      /** @internal Install Builder's checked bindings through a module declaration. */
      provideModule: (module: string, shape: ApiModuleShape, exports: unknown): (() => void) => provideModule(_bindings, module, shape, exports),
      /** Release an instance owned by this Runtime. Safe to repeat; foreign references cannot be released. */
      release: (value: object): boolean => this._objects?.release(value) ?? false,
    });
  }

  get modules(): string[] {
    return [...this._bindings.modules].filter(([, definition]) => definition.release !== undefined).map(([module]) => module);
  }

  start(node: SyncNode, registry: AddonRegistry): void {
    this._node = node;
    this._calls = createApiCalls(node, registry, this._bindings, this._apiData, () => this._node === node);
    this._objects = createObjectReferences(node, registry, this._bindings, (module, definition) => this._bindApi(module, definition));

    for (const [module, definition] of this._bindings.modules) { this._bindApi(module, definition); }

    this._bindings.connection.set({ node, registry, data: this._apiData, call: this._calls.call,
      bind: (module: string, definition: ApiDefinition): void => this._bindApi(module, definition) });
  }

  beginStop(): void { this._bindings.stopping = true; }
  endStop(): void { this._bindings.stopping = false; }

  stop(): void {
    const failures: unknown[] = [];

    const stop = (release: () => void): void => {
      try { release(); } catch (error) { failures.push(error); }
    };

    stop(() => this._bindings.connection.set(undefined));

    for (const release of [...this._bindings.subscriptions]) { stop(release); }

    stop(() => this._objects?.stop());
    this._objects = undefined;

    for (const release of this._releases.splice(0).reverse()) { stop(release); }

    this._bindings.modules.clear();
    this._bindings.subscriptions.clear();
    this._calls = undefined;
    this._node = undefined;

    if (failures.length > 0) { throw new AggregateError(failures, 'API cleanup failed'); }
  }

  private _bindApi(module: string, definition: ApiDefinition): void {
    const node = this._require(this._node, 'addon API');
    const releases: (() => void)[] = [];
    const declaration: { install(): void; stop(): void } = {
      install: (): void => {
        const initial = new Map<string, unknown>();

        eachLeaf(definition.shape, (shape, path) => {
          if (shape.kind === 'value' || shape.kind === 'local') { return; }

          const { value } = sourceAt(definition.exports, path, definition.reference !== undefined);

          if (shape.kind === 'function' && typeof value === 'function') { return; }

          if (shape.kind === 'event' && isEventSource(value)) { return; }

          if (shape.kind === 'state' && isStateSource(value)) {
            const snapshot: unknown = value.get();

            initial.set(memberKey(module, path), cloneData(transformData(snapshot, shape.data, 'encode', this._apiData)));

            return;
          }

          throw new Error(`export '${module}/${path.join('.')}' does not match its ${shape.kind} shape`);
        });
        eachLeaf(definition.shape, (shape, path) => {
          if (shape.kind === 'value' || shape.kind === 'local') { return; }

          const { value } = sourceAt(definition.exports, path, definition.reference !== undefined);
          const key = memberKey(module, path);

          if (shape.kind === 'function' && typeof value === 'function') {
            releases.push(node.rpc.onRequest(key, (params, from) => {
              const active = (): boolean => this._node === node && (definition.reference === undefined ? this._bindings.modules.get(module) === definition : definition.release !== undefined);
              const callbacks = shape.parameters === undefined
                ? undefined
                : this._require(this._calls, 'addon API').callbacks(from,
                    from === node.id ? node.bus.instanceId : node.discovery.getPeer(from)?.instanceId, active);
              const data = callbacks === undefined ? this._apiData : { ...this._apiData, callbacks };

              try {
                const { value: fn, receiver } = sourceAt(definition.exports, path, definition.reference !== undefined);

                if (!active() || typeof fn !== 'function') { throw new Error('addon API function is unavailable'); }

                const result: unknown = Reflect.apply(fn, receiver, decodeArguments(params, shape.parameters, data));

                if (!(result instanceof Promise)) { throw new Error('public functions must return a Promise'); }

                const pending = result.then((next: unknown): unknown => {
                  if (this._node !== node || (definition.reference === undefined && !active())) { throw new Error('provider stopped'); }

                  return transformData(next, shape.result, 'encode', this._apiData);
                });

                return callbacks === undefined
                  ? pending
                  : pending.then(
                      (next) => {
                        callbacks.close();

                        return next;
                      },
                      (error: unknown) => { callbacks.close(); throw error; },
                    );
              } catch (error) {
                callbacks?.close();

                throw error;
              }
            }));
          } else if (shape.kind === 'state' && isStateSource(value)) {
            releases.push(() => node.state.delete(node.id, key));
            node.state.set(node.id, key, initial.get(key));

            const publish = (next: unknown): void => {
              try { node.state.set(node.id, key, transformData(next, shape.data, 'encode', this._apiData)); } catch (error) {
                node.state.delete(node.id, key);

                throw error;
              }
            };

            const release: unknown = value.subscribe(publish);

            if (typeof release !== 'function') { throw new Error('observable subscribe must return an unsubscribe function'); }

            releases.push(() => { release(); });
          } else if (shape.kind === 'event' && isEventSource(value)) {
            const release: unknown = value.subscribe((payload: unknown): void => node.events.emit(key, transformData(payload, shape.data, 'encode', this._apiData)));

            if (typeof release !== 'function') { throw new Error('signal subscribe must return an unsubscribe function'); }

            releases.push(() => { release(); });
          }
        });
      },
      stop: (): void => {
        const index = this._releases.indexOf(declaration.stop);

        if (index >= 0) { this._releases.splice(index, 1); }

        const failures: unknown[] = [];

        for (const release of releases.splice(0).reverse()) {
          try { release(); } catch (error) { failures.push(error); }
        }

        definition.release = undefined;

        try { definition.onRelease?.(); } catch (error) { failures.push(error); }

        this._changed();

        if (failures.length) { throw new AggregateError(failures, 'API cleanup failed'); }
      },
    };

    this._releases.push(declaration.stop);

    try { declaration.install(); } catch (error) {
      try { declaration.stop(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'API installation and cleanup failed', { cause: cleanupError });
      }

      throw error;
    }

    definition.release = declaration.stop;
    this._changed();
  }

  private _require<T>(value: T | undefined, what: string): T {
    if (value === undefined) { throw new Error(`runtime.${what} is unavailable: call register() first`); }

    return value;
  }
}
