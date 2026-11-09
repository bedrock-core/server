/**
 * The cross-addon registry — a live directory of every bedrock-core addon present in the
 * world, built on the sync node's discovery. Peers advertise their Runtime registration
 * version in announce metadata; the registry merges the local addon with those peers,
 * keyed by the explicit addon namespace (e.g. `bt_gc_economy`).
 *
 * {@link AddonRegistry.addons} is the directory itself: an observable list derived from discovery, so
 * it can be watched or `computed` over exactly like a config leaf or a shared value. The registry
 * holds no directory state of its own — `all()`, `get()` and `has()` all read that one list — so
 * there is never a cached answer to "who is here" that can disagree with the live one.
 *
 * A collision (two addons with the same namespace) is surfaced via
 * {@link AddonRegistry.onNamespaceCollision} and logged. Dependencies are declared and matched
 * by namespace and are soft: a missing one warns but never blocks.
 *
 * A Core addon with an incompatible transport is absent from the directory.
 * {@link AddonRegistry.incompatible} identifies it from its announce metadata, so the addon list
 * can report the incompatibility.
 */
import {
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  type CollisionInfo,
  type Discovery,
  type IncompatibleListener,
  type IncompatiblePeer,
  type PeerInfo,
} from '@bedrock-core/sync';
import { computed, effect, observable, signal, type Computed, type Observable, type ReadonlyObservable, type Unsubscribe } from '@bedrock-core/observable';
import { system } from '@minecraft/server';
import { type AddonManifest, validateManifest, runtimeVersionFromPeer, RUNTIME_VERSION } from '../manifest';
import { readRegistryDescriptors, type RegistryDescriptor } from './descriptor';
import { Registry } from './base';

/**
 * The owning manifest, the addon namespace as `id`, whether it is local, and the
 * `@bedrock-core/server-runtime` version that addon was built against.
 * The addon's pack version remains in manifest.header.version.
 */
export interface RegisteredAddon {
  readonly manifest: AddonManifest;
  readonly id: string;
  readonly self: boolean;
  readonly runtimeVersion: string;
  readonly instanceId: string;
  readonly apis: readonly string[];
  readonly registries: readonly RegistryDescriptor[];
}

/** Told an addon that registered or unregistered. */
export type AddonListener = (addon: RegisteredAddon) => void;

/** Told two live addons claim the same namespace. */
export type CollisionListener = (info: CollisionInfo) => void;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Every bedrock-core addon in the world, from discovery: presence, dependencies, collisions. */
export class AddonRegistry extends Registry<RegisteredAddon, readonly RegisteredAddon[]> {
  /**
   * Every registered addon — the local addon, when present, plus live peers — as an observable list.
   *
   * Derived from `discovery.peers`, so it republishes exactly when the world changes and not on
   * the heartbeats that say nothing new. A registered local addon is always first;
   * API-only consumers list remote addons without adding a local registration.
   */
  readonly addons: ReadonlyObservable<readonly RegisteredAddon[]>;

  /**
   * This addon's declared dependencies that are not currently present, as an observable list.
   * Empty means satisfied.
   */
  readonly missing: ReadonlyObservable<readonly string[]>;

  private readonly _discovery: Discovery;
  private readonly _self: Observable<RegisteredAddon | undefined>;
  private readonly _addons: Computed<readonly RegisteredAddon[]>;
  private readonly _missing: Computed<readonly string[]>;
  private readonly _satisfied: Computed<boolean>;
  private readonly _onCollision = signal<CollisionInfo>();
  private readonly _onIncompatible = signal<IncompatiblePeer>();
  private readonly _disposers: Unsubscribe[] = [];

  constructor(discovery: Discovery, self?: AddonManifest, instanceId = '') {
    super();
    this._discovery = discovery;
    this._self = observable<RegisteredAddon | undefined>(self === undefined ? undefined : { manifest: self, id: self.namespace, self: true, runtimeVersion: RUNTIME_VERSION, instanceId, apis: Object.freeze([]), registries: Object.freeze([]) });

    this._addons = computed(
      () => [...(this._self.get() === undefined ? [] : [this._self.get()!]), ...discovery.peers.get().flatMap((peer) => {
        const addon = this._peerToAddon(peer);

        return addon ? [addon] : [];
      })],
      [this._self, discovery.peers],
      { label: 'registry.addons' },
    );
    this._missing = computed(
      () => [...new Set((this._self.get()?.manifest.dependencies ?? []).flatMap(dependency => dependency.namespace === undefined ? [] : [dependency.namespace]))].filter(id => !this.has(id)),
      [this._addons],
      { equals: sameIds, label: 'registry.missing' },
    );
    this._satisfied = computed(() => this._missing.get().length === 0, [this._missing]);

    this.addons = this._addons;
    this.missing = this._missing;
  }

  /** Bridge discovery's deltas into registry events and start reporting on dependencies. */
  start(): void {
    this._disposers.push(
      this._discovery.onCollision(info => this._handleCollision(info)),
      this._discovery.incompatiblePeers.subscribe((peers, previous) => {
        const known = new Set(previous.filter(peer => runtimeVersionFromPeer(peer.meta) !== undefined).map(peer => peer.id));

        for (const peer of peers) {
          if (!known.has(peer.id)) { this._handleIncompatible(peer); }
        }
      }),
      this._missing.subscribe((next, previous) => this._reportDependencies(next, previous)),
    );

    const missing = this._missing.get();

    if (missing.length > 0) {
      console.info(`[bedrock-core] '${this._self.get()?.id}' missing dependencies: ${missing.join(', ')}`);
    }
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    this._satisfied.dispose();
    this._missing.dispose();
    this._addons.dispose();
  }

  /** The local registration, or undefined for an API-only consumer endpoint. */
  get self(): RegisteredAddon | undefined { return this._self.get(); }

  get snapshot(): ReadonlyObservable<readonly RegisteredAddon[]> { return this.addons; }

  /** Every registered addon: the local addon plus all live peers. A snapshot of {@link AddonRegistry.addons}. */
  all(): readonly RegisteredAddon[] {
    return this._addons.get();
  }

  /** Look up an addon by its explicit namespace (e.g. `bt_gc_economy`). */
  get(id: string): RegisteredAddon | undefined {
    return this._addons.get().find(addon => addon.id === id);
  }

  /** @internal Public exports and registry descriptors share the addon's discovery advertisement. */
  setAdvertisements(apis: readonly string[], registries: readonly RegistryDescriptor[]): boolean {
    const self = this._self.get();

    if (self === undefined) { throw new Error('API providers require addon registration'); }

    if (sameIds(self.apis, apis) && JSON.stringify(self.registries) === JSON.stringify(registries)) { return false; }

    this._self.set({ ...self, apis: Object.freeze([...apis]), registries: readRegistryDescriptors(registries) });

    return true;
  }

  /** Wait for a registered addon's public export, bounded by ticks and this registry's lifetime. */
  whenApi(id: string, module: string, timeoutTicks = 100): Promise<RegisteredAddon> {
    return this._when(id, module, undefined, timeoutTicks);
  }

  /** Wait for one particular running addon; a replacement cannot satisfy an object reference. */
  whenInstance(id: string, instance: string, timeoutTicks = 100): Promise<RegisteredAddon> {
    return this._when(id, undefined, instance, timeoutTicks);
  }

  private _when(id: string, module: string | undefined, instance: string | undefined, timeoutTicks: number): Promise<RegisteredAddon> {
    const ready = this.get(id);

    if (ready && instance !== undefined && ready.instanceId !== instance) { return Promise.reject(new Error(`'${id}' was replaced`)); }

    if (ready && (module === undefined || ready.apis.includes(module))) { return Promise.resolve(ready); }

    return new Promise((resolve, reject) => {
      let settled = false;

      let unsubscribe = (): void => {};

      const finish = (error?: Error, addon?: RegisteredAddon): void => {
        if (settled) { return; }

        settled = true;

        system.clearRun(handle);

        unsubscribe();
        const index = this._disposers.indexOf(stop);

        if (index >= 0) { this._disposers.splice(index, 1); }

        if (error !== undefined) { reject(error); } else if (addon !== undefined) { resolve(addon); }
      };

      const stop = (): void => finish(new Error('runtime stopped'));

      const check = (): void => {
        const addon = this.get(id);

        if (addon && instance !== undefined && addon.instanceId !== instance) {
          finish(new Error(`'${id}' was replaced`));
        } else if (addon && (module === undefined || addon.apis.includes(module))) {
          finish(undefined, addon);
        } else if (this.incompatible().some(addon => addon.id === id)) {
          finish(new Error(`'${id}' has an incompatible transport`));
        }
      };

      this._disposers.push(stop);
      unsubscribe = this.addons.subscribe(check);
      const handle = system.runTimeout(() => finish(new Error(`'${module === undefined ? id : `${id}/${module}`}' is unavailable after ${timeoutTicks} ticks`)), timeoutTicks);

      check();
    });
  }

  /**
   * Notified when a peer addon registers (becomes visible). Returns an unsubscribe function.
   *
   * A delta, not a value: to react to who is present rather than to each arrival, subscribe to
   * {@link AddonRegistry.addons}.
   */
  onRegister(listener: AddonListener): Unsubscribe {
    return this._addons.subscribe((addons, previous) => {
      const known = new Set(previous.map(addon => addon.id));

      for (const addon of addons) {
        if (!addon.self && !known.has(addon.id)) { listener(addon); }
      }
    });
  }

  /** Notified when a peer addon unregisters (goes away). Returns an unsubscribe function. */
  onUnregister(listener: AddonListener): Unsubscribe {
    return this._addons.subscribe((addons, previous) => {
      const known = new Set(addons.map(addon => addon.id));

      for (const addon of previous) {
        if (!addon.self && !known.has(addon.id)) { listener(addon); }
      }
    });
  }

  /**
   * Addons heard on the bus that this build cannot talk to, because the protocol ranges the two
   * were built with do not overlap. Present in the world, absent from {@link AddonRegistry.all}.
   */
  incompatible(): readonly IncompatiblePeer[] {
    return this._discovery.incompatiblePeers.get().filter(peer => runtimeVersionFromPeer(peer.meta) !== undefined);
  }

  /** Notified the first time an unreachable addon is heard. Returns an unsubscribe function. */
  onIncompatible(listener: IncompatibleListener): Unsubscribe {
    return this._onIncompatible.subscribe(listener);
  }

  /** Notified when another addon shares our namespace. Returns an unsubscribe function. */
  onNamespaceCollision(listener: CollisionListener): Unsubscribe {
    return this._onCollision.subscribe(listener);
  }

  /** This addon's declared dependencies (namespaces) that are not currently present. */
  missingDependencies(): readonly string[] {
    return this._missing.get();
  }

  /**
   * Fires when all declared dependencies are present (immediately if already satisfied, e.g.
   * none were declared). Edge-triggered on each unsatisfied→satisfied transition. Returns an
   * unsubscribe function.
   */
  onDependenciesSatisfied(listener: () => void): Unsubscribe {
    const release = effect(() => {
      if (this._satisfied.get()) { listener(); }
    }, [this._satisfied], { label: 'registry.dependencies' });

    const stop = (): void => {
      release();
      const index = this._disposers.indexOf(stop);

      if (index >= 0) { this._disposers.splice(index, 1); }
    };

    this._disposers.push(stop);

    return stop;
  }

  private _peerToAddon(peer: PeerInfo): RegisteredAddon | undefined {
    const runtimeVersion = runtimeVersionFromPeer(peer.meta);

    if (runtimeVersion === undefined) { return undefined; }

    let manifest: AddonManifest;

    try { manifest = validateManifest(peer.meta?.manifest); } catch { return undefined; }

    if (manifest.namespace !== peer.id || manifest.header.version !== peer.version) { return undefined; }

    return { manifest, id: peer.id, self: false, runtimeVersion, instanceId: peer.instanceId,
      apis: Object.freeze(Array.isArray(peer.meta?.apis) ? peer.meta.apis.filter((name): name is string => typeof name === 'string') : []),
      registries: readRegistryDescriptors(peer.meta?.registries) };
  }

  private _reportDependencies(missing: readonly string[], previous: readonly string[]): void {
    if (missing.length === 0) {
      console.info(`[bedrock-core] '${this._self.get()?.id}' dependencies resolved: ${previous.join(', ')}`);

      return;
    }

    console.info(`[bedrock-core] '${this._self.get()?.id}' missing dependencies: ${missing.join(', ')}`);
  }

  private _handleIncompatible(peer: IncompatiblePeer): void {
    if (runtimeVersionFromPeer(peer.meta) === undefined) { return; }

    console.warn(
      `[bedrock-core] '${peer.id}' speaks sync protocol ${peer.pmin}-${peer.pmax}, this addon speaks `
      + `${PROTOCOL_MIN}-${PROTOCOL_MAX}; the two cannot talk. Update whichever is older.`,
    );

    this._onIncompatible.emit(peer);
  }

  private _handleCollision(info: CollisionInfo): void {
    console.error(`[bedrock-core] collision: another instance shares identity '${info.id}'`);

    this._onCollision.emit(info);
  }
}
