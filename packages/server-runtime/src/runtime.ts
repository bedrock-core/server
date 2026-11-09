/**
 * The bedrock-core server runtime.
 *
 * An addon registers itself once — that's it. {@link Runtime.register} validates the manifest
 * and immediately brings the addon online (no separate `start()`). Everything the addon
 * *declares* rides in that one call: identity in `manifest`, and beside it any number of
 * {@link Declaration} fields, each installing a subsystem and handing back its typed accessor
 * (see {@link RegisterOptions}). The runtime wraps a single sync `SyncNode` and exposes the
 * cross-addon {@link AddonRegistry} and public addon APIs.
 *
 * The default export is the `core` singleton — `import { core } from '@bedrock-core/server-runtime'`.
 * The `Runtime` class stands alone, so tests (and GameTests) can create several runtimes in one
 * script realm; they all talk over the real `system` script-event bus.
 */
import { SyncNode } from '@bedrock-core/sync';
import type { RuntimeServices } from './index';
import { attachRegistry, detachRegistry, InstallationScope, isDeclaration } from './installation';
import type { Declaration } from './library';
import { type AddonManifest, RUNTIME_VERSION, validateManifest } from './manifest';
import { AddonRegistry } from './registries/addons';
import { createBindings, defaultBindings, type Bindings } from './api/bindings';
import { RuntimeApi } from './api/runtime';
import { Registries } from './registries/registry';

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
 * Accessors inferred from declarations, keyed by their registration option names.
 * Runtime.register returns the same Runtime extended with non-conflicting accessor types.
 */
export type Declared<O> = {
  readonly [K in Exclude<keyof O, 'manifest'> as O[K] extends Declaration<unknown> ? K : never]:
  O[K] extends Declaration<infer T> ? T : never
};

/** Declaration accessors cannot replace built-in Runtime members. */
type RegisterFields<O, R> = { [K in Exclude<keyof O & keyof R, 'manifest'>]: never };

/** An addon's handle to the framework; `core` is the one a pack uses. */
export class Runtime {
  private readonly _api: RuntimeApi;
  private _node: SyncNode | undefined;
  private _addons: AddonRegistry | undefined;
  private _registries: Registries | undefined;
  private readonly _services = new Map<string, unknown>();
  private readonly _installations = new Map<Declaration<unknown>, InstallationScope>();
  private _installing: InstallationScope | undefined;
  private _stopping = false;
  readonly api: RuntimeApi['api'];

  constructor(bindings: Bindings = createBindings()) {
    this._api = new RuntimeApi(bindings, () => this._refreshAdvertisement());
    this.api = this._api.api;
  }

  /** Whether the addon has been registered (and is therefore live). */
  get registered(): boolean {
    return this._addons?.self !== undefined;
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
  get registry(): AddonRegistry {
    return this._require(this._addons, 'registry');
  }

  /**
   * Declare this addon and bring it online. Call exactly once. Throws on an invalid manifest
   * or a second registration. No separate start step is needed.
   *
   * Beyond identity, the options bag carries every {@link Declaration} the addon makes. Each
   * installs onto the live runtime in key order. Non-reserved keys become read-only Runtime
   * properties. The return value is this same instance, with those additional property types.
   */
  register<O extends RegisterOptions>(options: O & RegisterFields<O, this>): this & Omit<Declared<O>, keyof this>;
  register(options: RegisterOptions): this {
    this._requireActive();

    if (this.registered) { throw new Error('runtime is already registered'); }

    const validated = validateManifest(options.manifest);

    for (const [key, value] of Object.entries(options)) {
      if (key !== 'manifest' && isDeclaration(value) && key in this) {
        throw new Error(`runtime member '${key}' is reserved`);
      }
    }

    try {
      const namespace = validated.namespace;
      const node = new SyncNode({
        id: namespace,
        version: validated.header.version!,
        meta: { manifest: validated, runtimeVersion: RUNTIME_VERSION },
      });

      this._node = node;
      const registry = new AddonRegistry(node.discovery, validated, node.bus.instanceId);

      this._addons = registry;
      this._registries = new Registries(node, registry, () => this._refreshAdvertisement());
      attachRegistry(this, this._registries);
      node.start();
      registry.start();
      this._registries.start();
      this._api.start(node, registry);

      for (const [key, value] of Object.entries(options)) {
        if (key === 'manifest' || !isDeclaration(value)) { continue; }

        const accessor = this.install(value);

        Object.defineProperty(this, key, { value: accessor, enumerable: true, configurable: true });
        this._installations.get(value)?.defer(() => { Reflect.deleteProperty(this, key); });
      }

      return this;
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
    this._requireActive();

    if (this._installations.has(declaration)) { throw new Error('library declaration is already installed'); }

    const previous = this._installing;
    const lifetime = new InstallationScope();

    this._installations.set(declaration, lifetime);
    lifetime.defer(() => this._installations.delete(declaration));
    this._installing = lifetime;

    try {
      previous?.attach(() => this._releaseInstallation(lifetime));

      return lifetime.own(declaration.install(this, lifetime));
    } catch (error) {
      try { this._releaseInstallation(lifetime); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'library installation and cleanup failed', { cause: cleanupError });
      }

      throw error;
    } finally {
      this._installing = previous;
    }
  }

  /** Withdraw one owned installation and its nested libraries. Repeating withdrawal returns false. */
  uninstall(declaration: Declaration<unknown>): boolean {
    const lifetime = this._installations.get(declaration);

    if (lifetime === undefined) { return false; }

    this._releaseInstallation(lifetime);

    return true;
  }

  /**
   * Register a local service during library installation. The declaration owns its cleanup.
   * Duplicate registration throws; service instances are not published across realms.
   */
  provideService<K extends keyof RuntimeServices>(key: K, value: RuntimeServices[K]): void {
    this._requireManifest();

    this._requireActive();

    if (this._services.has(key)) { throw new Error(`runtime service '${String(key)}' is already registered`); }

    this._services.set(key, value);
    this._installing?.defer(() => this._services.delete(key));
  }

  /**
   * Read a local library service, or `undefined` when it is not installed.
   * The owning library augments {@link RuntimeServices} and defines its accessor.
   */
  service<K extends keyof RuntimeServices>(key: K): RuntimeServices[K] | undefined {
    // Only provideService writes this map, with the value type belonging to its key.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return this._services.get(key) as RuntimeServices[K] | undefined;
  }

  /** Take the addon offline and clear queued API bindings. Safe to call before registering. */
  stop(): void {
    if (this._stopping) { return; }

    this._stopping = true;
    this._api.beginStop();
    const failures: unknown[] = [];

    const stop = (release: () => void): void => {
      try { release(); } catch (error) { failures.push(error); }
    };

    stop(() => this._api.stop());

    for (const lifetime of [...this._installations.values()].reverse()) {
      stop(() => this._releaseInstallation(lifetime));
    }

    detachRegistry(this);
    stop(() => this._registries?.stop());
    stop(() => this._addons?.stop());
    stop(() => this._node?.stop());

    this._services.clear();
    this._addons = undefined;
    this._registries = undefined;
    this._node = undefined;
    this._api.endStop();
    this._stopping = false;

    if (failures.length > 0) { throw new AggregateError(failures, 'runtime cleanup failed'); }
  }

  private _refreshAdvertisement(): void {
    const self = this._addons?.self;

    if (this._stopping || this._node === undefined || this._addons === undefined || self === undefined) { return; }

    const apis = this._api.modules;
    const registries = this._registries?.descriptors() ?? [];

    if (this._addons.setAdvertisements(apis, registries)) {
      this._node.discovery.updateMeta({ manifest: self.manifest, runtimeVersion: RUNTIME_VERSION, apis, registries });
    }
  }

  private _requireManifest(): AddonManifest {
    return this._require(this._addons?.self?.manifest, 'manifest');
  }

  private _requireActive(): void {
    if (this._stopping || this._installing?.stopped) { throw new Error('runtime is stopping'); }
  }

  private _releaseInstallation(lifetime: InstallationScope): void {
    const previous = this._installing;

    this._installing = lifetime;

    try { lifetime.stop(); } finally { this._installing = previous; }
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
