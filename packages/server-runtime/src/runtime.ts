/**
 * The bedrock-core server runtime.
 *
 * An addon registers itself once — that's it. {@link Runtime.register} validates the manifest
 * and immediately brings the addon online (no separate `start()`). Everything the addon
 * *declares* rides in that one call: identity in `manifest`, and beside it any number of
 * {@link Declaration} fields, each installing a subsystem and handing back its typed accessor
 * (see {@link RegisterOptions}). The runtime wraps a single sync `SyncNode` and exposes the
 * cross-addon {@link Registry}, the {@link FeatureManager} and the messaging passthroughs.
 *
 * The default export is the `core` singleton — `import { core } from '@bedrock-core/server-runtime'`.
 * The `Runtime` class stands alone, so tests (and GameTests) can create several runtimes in one
 * script realm; they all talk over the real `system` script-event bus.
 */
import type { Db } from '@bedrock-core/db';
import { createEngineDb } from '@bedrock-core/db/minecraft';
import { currentI18n } from '@bedrock-core/i18n';
import type { Rpc } from '@bedrock-core/sync';
import { SyncNode } from '@bedrock-core/sync';
import { system } from '@minecraft/server';
import { type Declaration, isDeclaration } from './declaration';
import { EventsRegistry } from './events/events-registry';
import { FeatureManager } from './features';
import { HostElection } from './host';
import { type AddonManifest, addonNamespace, manifestToMeta, validateManifest } from './manifest';
import { Registry } from './registry';
import { SharedRegistry } from './shared/shared-registry';
import { TranslationsRegistry } from './translations';

/**
 * Everything an addon declares when it registers: the identity `manifest`, plus one field per
 * declaration — `config: registerConfig(definition)`, `shared: registerShared(keys)`, `events: registerEvents(tree)`.
 * One bag — "tell core what you are" — then run your own code.
 *
 * A field holding a {@link Declaration} is installed and its accessor comes back under that same
 * key; anything else in the bag is ignored. Declarations install in the order their keys were
 * written, onto an already-live runtime.
 */
export interface RegisterOptions {

  /** Who this addon is: creator, pack, display names, version, dependencies. */
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
  private _node: SyncNode | undefined;
  private _registry: Registry | undefined;
  private _features: FeatureManager | undefined;
  private _manifest: AddonManifest | undefined;
  private _db: Db | undefined;
  private _translations: TranslationsRegistry | undefined;
  private _host: HostElection | undefined;
  private _shared: SharedRegistry | undefined;
  private _events: EventsRegistry | undefined;
  private _slots = new Map<string, unknown>();
  private readonly _declarations: Declaration<unknown>[] = [];

  /** Whether the addon has been registered (and is therefore live). */
  get registered(): boolean {
    return this._manifest !== undefined;
  }

  /**
   * This addon's namespace: `creator_pack` (e.g. `bt_gc_economy`).
   *
   * The one identifier it is known by — RPC targeting, mirror keys, dependency declarations,
   * and the namespace of any custom command or command enum it registers.
   */
  get id(): string {
    return addonNamespace(this.requireManifest());
  }

  /** Alias of {@link id}, for code that reads better naming the namespace than the id. */
  get namespace(): string {
    return this.id;
  }

  /** This addon's manifest. */
  get manifest(): AddonManifest {
    return this.requireManifest();
  }

  /** The cross-addon registry. */
  get registry(): Registry {
    return this.require(this._registry, 'registry');
  }

  /** The feature manager — use `core.features.add()` to declare features, `core.features.of()` for cross-addon reads. */
  get features(): FeatureManager {
    return this.require(this._features, 'features');
  }

  /** Cross-addon i18n bundles — publish via `core.translations.provide()`; `forPlayer(player)` for the chained resolver, `of(addonId)` for a peer's verbs. */
  get translations(): TranslationsRegistry {
    return this.require(this._translations, 'translations');
  }

  /** Host election — `core.host.isHost` tells you whether this realm should do the work only one realm may do, and `core.host.id` is that realm as an observable. Nothing in the stack elects anything today; see `host.ts`. */
  get host(): HostElection {
    return this.require(this._host, 'host');
  }

  /**
   * The shared mirror as typed trees: this addon's own comes back from its `shared: registerShared(keys)`
   * declaration, a peer's from `core.shared.of<Def>(ns)` — which an addon that declares nothing of
   * its own may read too. Every node has `get` / `subscribe`; own nodes and opened peer leaves also
   * `set`.
   */
  get shared(): SharedRegistry {
    this._shared ??= new SharedRegistry({ state: this.requireNode().state, namespace: this.namespace });

    return this._shared;
  }

  /**
   * Events as typed trees: this addon's own comes back from its `events: registerEvents(tree)` declaration,
   * another addon's from `core.events.of<Def>(ns)` — open to an addon that announces nothing itself.
   * An owner's node has `emit` and `subscribe`, a peer's `subscribe` alone, and a listener may be
   * attached before the announcing addon exists.
   */
  get events(): EventsRegistry {
    this._events ??= new EventsRegistry({ events: this.requireNode().events, namespace: this.namespace });

    return this._events;
  }

  /**
   * Persisted documents for this addon, keyed by target — players, entities, blocks, the world —
   * on whatever dynamic properties the target itself can hold: `core.db.collection(name, { schema, accept })`.
   * Its keys live under this addon's namespace, so two addons never meet. Local: nothing here is
   * reachable from another realm unless this addon serves it.
   */
  get db(): Db {
    return this.require(this._db, 'db');
  }

  /** RPC messaging (passthrough to the underlying sync node). */
  get rpc(): Rpc {
    return this.requireNode().rpc;
  }

  /** The underlying sync node, for advanced access (bus, discovery). */
  get node(): SyncNode {
    return this.requireNode();
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
    if (this._manifest) { throw new Error('runtime is already registered'); }

    const validated = validateManifest(options.manifest);

    this._manifest = validated;

    // One namespace for everything this addon owns — transport id, mirror, config, guides.
    const namespace = addonNamespace(validated);

    const node = new SyncNode({
      id: namespace,
      version: validated.version,
      meta: manifestToMeta(validated),
      // Only owned namespaces are answered in sync's late-join snapshot exchange.
      ownedNamespaces: [namespace],
    });
    const registry = new Registry(node.discovery, validated);
    const features = new FeatureManager(registry, node.state, namespace);
    // Local persistence, live before any declaration: a declaration stores through it.
    const db = createEngineDb(namespace, message => console.warn(message));
    const translations = new TranslationsRegistry(node.state, namespace);
    const host = new HostElection(registry, namespace);

    this._node = node;
    this._registry = registry;
    this._features = features;
    this._db = db;
    this._translations = translations;
    this._host = host;

    node.start();
    registry.start();
    features.start();
    translations.start();

    const declared: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(options)) {
      if (key === 'manifest' || !isDeclaration(value)) { continue; }

      this._declarations.push(value);
      declared[key] = value.install(this);
    }

    // This addon's own strings, on the first tick. `createI18n(bundle)` runs in a module the
    // entry imports, so the instance exists by now; publishing it from the floor is what lets an
    // addon that draws nothing still have the translation keys in its manifest — `packName`,
    // `creatorName`, `description` — resolved by whatever realm lists it.
    system.run(() => { this.publishOwnTranslations(); });

    return declared;
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

  /** Take the addon offline. Safe to call before registering (no-op). */
  stop(): void {
    // Reverse install order: a declaration comes down before what it was built on.
    for (const declaration of this._declarations.splice(0).reverse()) {
      declaration.stop?.();
    }

    this._host?.stop();
    this._translations?.stop();
    this._features?.stop();
    this._registry?.stop();
    this._node?.stop();
    this._slots.clear();
    this._events = undefined;
    this._shared = undefined;
    this._host = undefined;
    this._translations = undefined;
    this._features = undefined;
    this._registry = undefined;
    this._db = undefined;
    this._node = undefined;
    this._manifest = undefined;
  }

  /**
   * Announce the bundle this addon's default i18n instance was created with.
   *
   * Nothing happens for an addon that created none, and nothing happens if the runtime was
   * stopped before the tick arrived. A package above the floor may publish a different bundle
   * afterwards; the last one announced is what peers read.
   */
  private publishOwnTranslations(): void {
    const bundle = currentI18n()?.bundle;

    if (bundle === undefined || this._translations === undefined) { return; }

    this._translations.provide(bundle);
  }

  private requireManifest(): AddonManifest {
    return this.require(this._manifest, 'manifest');
  }

  private requireNode(): SyncNode {
    return this.require(this._node, 'node');
  }

  private require<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
      throw new Error(`runtime.${what} is unavailable: call register() first`);
    }

    return value;
  }
}

/** The default runtime singleton. */
export const core = new Runtime();
