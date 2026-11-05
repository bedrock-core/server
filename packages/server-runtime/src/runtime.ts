/**
 * The bedrock-core server runtime.
 *
 * An addon registers itself once — that's it. {@link Runtime.register} validates the manifest
 * and immediately brings the addon online (no separate `start()`). Everything the addon
 * *declares* rides in that one call: identity in `manifest`, and beside it any number of
 * {@link Declaration} fields, each installing a subsystem and handing back its typed accessor
 * (see {@link RegisterOptions}). The runtime wraps a single sync `SyncNode` and exposes the
 * cross-addon {@link Registry} and public addon APIs.
 *
 * The default export is the `core` singleton — `import { core } from '@bedrock-core/server-runtime'`.
 * The `Runtime` class stands alone, so tests (and GameTests) can create several runtimes in one
 * script realm; they all talk over the real `system` script-event bus.
 */
import type { Db } from '@bedrock-core/db';
import { createEngineDb } from '@bedrock-core/db/minecraft';
import { currentI18n } from '@bedrock-core/i18n';
import { SyncNode } from '@bedrock-core/sync';
import { system } from '@minecraft/server';
import { type Declaration, isDeclaration } from './declaration';
import { HostElection } from './host';
import { type AddonManifest, RUNTIME_VERSION, validateManifest } from './manifest';
import { Registry } from './registry';
import { createBindings, createModule, defaultBindings, memberKey, provideModule, type ApiDefinition, type Bindings } from './api/bindings';
import { cloneData } from '@bedrock-core/sync/data';
import { isRecord } from './guards';
import type { ApiModule, ApiModuleShape, ApiShape } from './api/types';
import { decodeArguments, transformData, type ApiDataContext } from './api/codec';
import { nativeReferences } from './api/references';
import { nativeValues } from './api/native-values';
import { createObjectReferences } from './api/objects';
import { createApiCalls } from './api/calls';
import { createApiView } from './api/declaration';
import type { ReadonlyObservable, Signal } from '@bedrock-core/observable';
import { TranslationsRegistry } from './translations';

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

/**
 * Everything an addon declares when it registers: the identity `manifest`, plus one field per
 * declaration — for example, `config: registerConfig(definition)`.
 * One bag — "tell core what you are" — then run your own code.
 *
 * A field holding a {@link Declaration} is installed and its accessor comes back under that same
 * key; anything else in the bag is ignored. Declarations install in the order their keys were
 * written, onto an already-live runtime.
 */
export interface RegisterOptions {

  /** The owning authored Minecraft manifest, resolved by Builder before bundling. */
  manifest: AddonManifest;
}

/**
 * What `register()` hands back: one entry per declaration in the options bag, under the key it was
 * declared as, typed by what that declaration's `install` returns.
 */
export type Declared<O> = {
  [K in Exclude<keyof O, 'manifest'> as O[K] extends Declaration<unknown> ? K : never]:
  O[K] extends Declaration<infer T> ? T : never
};

/**
 * The subsystems a package outside this repository parks on the runtime, keyed by name.
 *
 * Empty here, and filled in by module augmentation from the package that owns each subsystem — the
 * floor never imports what it holds:
 *
 * ```ts
 * declare module '@bedrock-core/server-runtime' {
 *   interface RuntimeSlots { 'acme:widgets': WidgetRegistry }
 * }
 * ```
 *
 * A key is namespaced the way a feed or an rpc method is, so two packages that both augment this
 * never collide. A declaration fills its slot from `install`, through
 * {@link Runtime.fill}, and the owning package reads it back with {@link Runtime.slot} — deciding
 * for itself what an unfilled slot means, since only it knows whether absence is an error or the
 * ordinary state of an addon that declared nothing.
 */
export interface RuntimeSlots {}

/** An addon's handle to the framework; `core` is the one a pack uses. */
export class Runtime {
  private readonly _bindings: Bindings;
  private _node: SyncNode | undefined;
  private _registry: Registry | undefined;
  private _manifest: AddonManifest | undefined;
  private _db: Db | undefined;
  private _translations: TranslationsRegistry | undefined;
  private _host: HostElection | undefined;
  private _slots = new Map<string, unknown>();
  private readonly _declarations: Declaration<unknown>[] = [];
  private _translationTask: number | undefined;
  private _calls: ReturnType<typeof createApiCalls> | undefined;
  private _objects: ReturnType<typeof createObjectReferences> | undefined;
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

  constructor(bindings: Bindings = createBindings()) {
    this._bindings = bindings;
    this.api = Object.freeze({
      of: <T extends object>(namespace: string, implementation: T): ApiModule<T> => createApiView(bindings, namespace, implementation),
      createModule: <T>(namespace: string, module: string, shape: ApiModuleShape): ApiModule<T> => createModule<T>(bindings, namespace, module, shape),
      provideModule: (module: string, shape: ApiModuleShape, exports: unknown): (() => void) => provideModule(bindings, module, shape, exports),
      /** Release an instance owned by this Runtime. Safe to repeat; foreign references cannot be released. */
      release: (value: object): boolean => this._objects?.release(value) ?? false,
    });
  }

  /** Whether the addon has been registered (and is therefore live). */
  get registered(): boolean {
    return this._manifest !== undefined;
  }

  /**
   * This addon's explicitly declared namespace (e.g. `bt_gc_economy`).
   *
   * The one identifier it is known by — RPC targeting, mirror keys, dependency declarations,
   * and the namespace of any custom command or command enum it registers.
   */
  get id(): string {
    return this._requireManifest().namespace;
  }

  /** Alias of {@link id}, for code that reads better naming the namespace than the id. */
  get namespace(): string {
    return this.id;
  }

  /** This addon's manifest. */
  get manifest(): AddonManifest {
    return this._requireManifest();
  }

  /** The cross-addon registry. */
  get registry(): Registry {
    return this._require(this._registry, 'registry');
  }

  /** Cross-addon i18n bundles — publish via `core.translations.provide()`; `forPlayer(player)` for the chained resolver, `of(addonId)` for a peer's verbs. */
  get translations(): TranslationsRegistry {
    return this._require(this._translations, 'translations');
  }

  /** Host election — `core.host.isHost` tells you whether this realm should do the work only one realm may do, and `core.host.id` is that realm as an observable. Nothing in the stack elects anything today; see `host.ts`. */
  get host(): HostElection {
    return this._require(this._host, 'host');
  }

  /**
   * Persisted documents for this addon, keyed by target — players, entities, blocks, the world —
   * on whatever dynamic properties the target itself can hold: `core.db.collection(name, { schema, accept })`.
   * Its keys live under this addon's namespace, so two addons never meet. Local: nothing here is
   * reachable from another realm unless this addon serves it.
   */
  get db(): Db {
    return this._require(this._db, 'db');
  }

  /**
   * Declare this addon and bring it online. Call exactly once. Throws on an invalid manifest
   * or a second registration. No separate start step is needed.
   *
   * Beyond identity, the options bag carries every {@link Declaration} the addon makes. Each
   * installs onto the live runtime in the order its key was written, and the result holds that
   * declaration's accessor under the same key.
   */
  register<O extends RegisterOptions>(options: O): Declared<O>;
  register(options: RegisterOptions): Record<string, unknown> {
    if (this._bindings.stopping) { throw new Error('runtime is stopping'); }

    if (this._manifest) { throw new Error('runtime is already registered'); }

    const validated = validateManifest(options.manifest);

    this._manifest = validated;

    try {
      const namespace = validated.namespace;
      const node = new SyncNode({
        id: namespace,
        version: validated.header.version!,
        meta: { manifest: validated, runtimeVersion: RUNTIME_VERSION },
      });

      this._node = node;
      const registry = new Registry(node.discovery, validated, node.bus.instanceId);

      this._registry = registry;
      this._db = createEngineDb(namespace, message => console.warn(message));
      const translations = new TranslationsRegistry(node.state, namespace);

      this._translations = translations;
      this._host = new HostElection(registry, namespace);
      this._calls = createApiCalls(node, registry, this._bindings, this._apiData, () => this._node === node);
      this._objects = createObjectReferences(node, registry, this._bindings, (module, definition) => this._bindApi(module, definition));

      for (const [module, definition] of this._bindings.modules) { this._bindApi(module, definition); }

      node.start();
      registry.start();
      translations.start();
      this._bindings.connection.set({
        node, registry, data: this._apiData,
        call: this._calls.call,
        bind: (module: string, definition: ApiDefinition): void => this._bindApi(module, definition),
      });

      const declared: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(options)) {
        if (key === 'manifest' || !isDeclaration(value)) { continue; }

        declared[key] = this.install(value);
      }

      this._translationTask = system.run(() => {
        this._translationTask = undefined;

        if (this._manifest === validated) { this._publishOwnTranslations(); }
      });

      return declared;
    } catch (error) {
      try { this.stop(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'runtime registration and cleanup failed', { cause: cleanupError });
      }

      throw error;
    }
  }

  /** Install a subsystem on a registered runtime. Its stop hook runs with the runtime in reverse install order. */
  install<T>(declaration: Declaration<T>): T {
    this._requireManifest();

    if (this._bindings.stopping) { throw new Error('runtime is stopping'); }

    const first = this._declarations.length;
    const slots = new Set(this._slots.keys());

    this._declarations.push(declaration);

    try {
      return declaration.install(this);
    } catch (error) {
      const failures: unknown[] = [error];

      for (const installed of this._declarations.splice(first).reverse()) {
        try { installed.stop?.(); } catch (cleanupError) { failures.push(cleanupError); }
      }

      for (const key of this._slots.keys()) {
        if (!slots.has(key)) { this._slots.delete(key); }
      }

      if (failures.length > 1) { throw new AggregateError(failures, 'service installation and cleanup failed', { cause: error }); }

      throw error;
    }
  }

  /**
   * What is parked under `key`, or `undefined` when nothing filled that slot. The package that
   * augmented {@link RuntimeSlots} with the key is the one that reads it, and the one that decides
   * what absence means.
   */
  slot<K extends keyof RuntimeSlots>(key: K): RuntimeSlots[K] | undefined {
    // Only `fill` writes the map, and it writes `RuntimeSlots[K]` under `K`.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return this._slots.get(key) as RuntimeSlots[K] | undefined;
  }

  /**
   * Park a subsystem under `key`. Called by a declaration's `install`, which owns building the
   * thing; the runtime only hands it back. A slot is filled once — a second fill throws rather
   * than leaving two owners of one key.
   */
  fill<K extends keyof RuntimeSlots>(key: K, value: RuntimeSlots[K]): void {
    if (this._slots.has(key)) { throw new Error(`runtime slot '${String(key)}' is already filled`); }

    this._slots.set(key, value);
  }

  /** Take the addon offline and clear queued API bindings. Safe to call before registering. */
  stop(): void {
    if (this._bindings.stopping) { return; }

    this._bindings.stopping = true;
    const failures: unknown[] = [];

    const stop = (release: () => void): void => {
      try { release(); } catch (error) { failures.push(error); }
    };

    if (this._translationTask !== undefined) {
      const task = this._translationTask;

      this._translationTask = undefined;
      stop(() => system.clearRun(task));
    }

    stop(() => this._bindings.connection.set(undefined));

    for (const release of [...this._bindings.subscriptions]) { stop(release); }

    stop(() => this._objects?.stop());
    this._objects = undefined;

    for (const declaration of this._declarations.splice(0).reverse()) {
      stop(() => declaration.stop?.());
    }

    stop(() => this._host?.stop());
    stop(() => this._translations?.stop());
    stop(() => this._registry?.stop());
    stop(() => this._db?.stop());
    stop(() => this._node?.stop());
    this._bindings.modules.clear();
    this._bindings.subscriptions.clear();
    this._slots.clear();
    this._host = undefined;
    this._translations = undefined;
    this._registry = undefined;
    this._db = undefined;
    this._node = undefined;
    this._calls = undefined;
    this._manifest = undefined;
    this._bindings.stopping = false;

    if (failures.length > 0) { throw new AggregateError(failures, 'runtime cleanup failed'); }
  }

  private _refreshApis(): void {
    if (this._bindings.stopping || this._node === undefined || this._registry === undefined || this._manifest === undefined) { return; }

    const apis = [...this._bindings.modules].filter(([, definition]) => definition.release !== undefined).map(([module]) => module);

    if (this._registry.setApis(apis)) {
      this._node.discovery.updateMeta({ manifest: this._manifest, runtimeVersion: RUNTIME_VERSION, apis });
    }
  }

  private _bindApi(module: string, definition: ApiDefinition): void {
    const node = this._require(this._node, 'addon API');
    const releases: (() => void)[] = [];
    const declaration: Declaration<void> = {
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
        const index = this._declarations.indexOf(declaration);

        if (index >= 0) { this._declarations.splice(index, 1); }

        const failures: unknown[] = [];

        for (const release of releases.splice(0).reverse()) {
          try { release(); } catch (error) { failures.push(error); }
        }

        definition.release = undefined;

        try { definition.onRelease?.(); } catch (error) { failures.push(error); }

        this._refreshApis();

        if (failures.length) { throw new AggregateError(failures, 'API cleanup failed'); }
      },
    };

    this.install(declaration);
    definition.release = declaration.stop;
    this._refreshApis();
  }

  /**
   * Announce the bundle this addon's default i18n instance was created with.
   *
   * Nothing happens for an addon that created none, and nothing happens if the runtime was
   * stopped before the tick arrived. A package above the floor may publish a different bundle
   * afterwards; the last one announced is what peers read.
   */
  private _publishOwnTranslations(): void {
    const bundle = currentI18n()?.bundle;

    if (bundle === undefined || this._translations === undefined) { return; }

    this._translations.provide(bundle);
  }

  private _requireManifest(): AddonManifest {
    return this._require(this._manifest, 'manifest');
  }

  private _require<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new Error(`runtime.${what} is unavailable: call register() first`);
    }

    return value;
  }
}

/** The default runtime singleton. */
export const core = new Runtime(defaultBindings);
