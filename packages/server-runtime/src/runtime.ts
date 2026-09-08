/**
 * The bedrock-core server runtime.
 *
 * An addon registers itself once — that's it. {@link Runtime.register} validates the manifest
 * and immediately brings the addon online (no separate `start()`). Everything the addon
 * *declares* rides in that one call: identity, plus the optional `translations`, `guide`,
 * `config` and `shared` fields (see {@link RegisterOptions}). The runtime wraps a single sync
 * `SyncNode` and exposes the cross-addon {@link Registry}, the {@link FeatureManager}, the
 * shared mirror and messaging passthroughs.
 *
 * The default export is the `core` singleton — `import { core } from '@bedrock-core/server-runtime'`.
 * The `Runtime` class stands alone, so tests (and GameTests) can create several runtimes in one
 * script realm; they all talk over the real `system` script-event bus.
 */
import { SyncNode } from '@bedrock-core/sync';
import { addonNamespace, type AddonManifest, manifestToMeta, validateManifest } from './manifest';
import { FeatureManager } from './features';
import { Registry } from './registry';
import { ConfigRegistry, type Config } from './config/config-registry';
import type { ConfigDefinition } from './config/schema';
import type { I18nBundle } from '@bedrock-core/i18n';
import { TranslationsRegistry } from './translations';
import { GuidesRegistry } from './guides/guides-registry';
import { type AddonPageReference, PagesRegistry } from './pages/pages-registry';
import { HostElection } from './host';
import type { GuideManifest, GuideReference } from './guides/types';
import type { Rpc } from '@bedrock-core/sync';
import { createEngineDb } from '@bedrock-core/db/minecraft';
import type { Db } from '@bedrock-core/db';
import { SharedRegistry } from './shared/shared-registry';
import type { SharedDef, SharedTree } from './shared/tree';
import { EventsRegistry } from './events/events-registry';
import type { EventsDef, EventsTree } from './events/tree';

/**
 * Everything an addon declares when it registers: the identity `manifest` plus the optional
 * cross-addon data beside it. One bag — "tell core what you are" — then run your own code. Each
 * optional field is sugar for the corresponding post-register call and behaves identically:
 *
 * - `translations` → `core.translations.provide()`
 * - `guide` → `core.guides.provideManifest()`
 * - `config` → `core.config.define()` (its typed accessors become `register()`'s return value)
 * - `shared` → `core.shared.define()` (its typed tree is `register()`'s `shared`)
 * - `events` → `core.events.define()` (its typed tree is `register()`'s `events`)
 *
 * The standalone calls remain available for addons that need to publish late or replace data
 * at runtime.
 */
export interface RegisterOptions<
  I extends ConfigDefinition | undefined = ConfigDefinition | undefined,
  S extends SharedDef | undefined = SharedDef | undefined,
  E extends EventsDef | undefined = EventsDef | undefined,
> {

  /** Who this addon is: creator, pack, display names, version, dependencies. */
  manifest: AddonManifest;

  /**
   * This addon's i18n bundle (`@bedrock-core/generated/i18n`, or a
   * `createResourceBundle` result), published to replicated state so other
   * addons' UIs can resolve and measure its strings — and get verbs over them
   * via `core.translations.of()`.
   */
  translations?: I18nBundle;

  /** This addon's compiled guide manifest (`@bedrock-core/generated/guides`), published for the elected host to render. */
  guide?: GuideManifest;

  /**
   * This addon's guide as a reference (`guideReference(ns)` from `@bedrock-core/guides`),
   * published for the elected host to present with native forms — every client already
   * holds the compiled screens in the pack. Beside `guide` while hosts that only render
   * manifests are around; instead of it once they are not.
   */
  guideReference?: GuideReference;

  /**
   * This addon's page in the shared addon list as a reference
   * (`addonPageReference(Page)` from `@bedrock-core/config/compiled`): per
   * reserved entry the value it is shown with and where a press leads. The
   * page itself is a compiled screen in this addon's pack, which every client
   * holds; the elected host draws it into its list from this alone.
   */
  page?: AddonPageReference;

  /** This addon's config schema. When given, `register()` returns the typed scope accessors. */
  config?: I;

  /**
   * This addon's shared keys: a flat record whose values every realm mirrors and only this addon
   * writes. When given, `register()`'s result carries the typed tree as `shared`.
   */
  shared?: S;

  /**
   * What this addon announces to every realm: `{ purchase: event<{ playerId: string }>() }`.
   * Delivered once and kept by nobody. When given, `register()`'s result carries the typed tree
   * as `events`.
   */
  events?: E;
}

/**
 * What `register()` hands back: one entry per declaration that has accessors, each under the key
 * it was declared as — `config` for the scope accessors, `shared` for the shared tree.
 */
export type Registered<I extends ConfigDefinition | undefined, S extends SharedDef | undefined, E extends EventsDef | undefined = undefined>
  = (I extends ConfigDefinition ? { config: Config<I> } : unknown)
    & (S extends SharedDef ? { shared: SharedTree<S> } : unknown)
    & (E extends EventsDef ? { events: EventsTree<E> } : unknown);

export class Runtime {
  private _node: SyncNode | undefined;
  private _registry: Registry | undefined;
  private _features: FeatureManager | undefined;
  private _manifest: AddonManifest | undefined;
  private _shared: SharedRegistry | undefined;
  private _events: EventsRegistry | undefined;
  private _db: Db | undefined;
  private _config: ConfigRegistry | undefined;
  private _translations: TranslationsRegistry | undefined;
  private _guides: GuidesRegistry | undefined;
  private _pages: PagesRegistry | undefined;
  private _host: HostElection | undefined;

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

  /** The config registry — declare this addon's config via `register({ config })` (or `core.config.define()` for late definition). */
  get config(): ConfigRegistry {
    return this.require(this._config, 'config');
  }

  /** Cross-addon i18n bundles — publish via `register({ translations })` (or `core.translations.provide()`); `forPlayer(player)` for the chained resolver, `of(addonId)` for a peer's verbs. */
  get translations(): TranslationsRegistry {
    return this.require(this._translations, 'translations');
  }

  /** Cross-addon guides — publish via `register({ guide })` (or `core.guides.provideManifest()` to replace at runtime), `core.guides.of()` for cross-addon reads. */
  /** Cross-addon list pages — publish via `register({ page })` (or `core.pages.provide()` to replace at runtime), `core.pages.of()` for the host's reads. */
  get pages(): PagesRegistry {
    return this.require(this._pages, 'pages');
  }

  get guides(): GuidesRegistry {
    return this.require(this._guides, 'guides');
  }

  /** Host election — `core.host.isHost` tells you whether this realm should do the work only one realm may do (e.g. render the shared UI). */
  get host(): HostElection {
    return this.require(this._host, 'host');
  }

  /**
   * The shared mirror as typed trees: this addon's own from `register({ shared })`, a peer's via
   * `core.shared.of<Def>(ns)`. Every node has `get` / `subscribe`; own nodes and opened peer
   * leaves also `set`.
   */
  get shared(): SharedRegistry {
    return this.require(this._shared, 'shared');
  }

  /**
   * Events as typed trees: this addon's own from `register({ events })`, another addon's via
   * `core.events.of<Def>(ns)`. An owner's node has `emit` and `subscribe`, a peer's `subscribe`
   * alone, and a listener may be attached before the announcing addon exists.
   */
  get events(): EventsRegistry {
    return this.require(this._events, 'events');
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
   * Beyond identity, the options bag carries everything the addon declares up front:
   * `translations`, `guide`, `config` and `shared` (see {@link RegisterOptions}). The result holds
   * the typed accessors of what was declared, each under its own key: `config` — the same value
   * `core.config.define()` would return — and `shared`.
   */
  register<
    I extends ConfigDefinition | undefined = undefined,
    S extends SharedDef | undefined = undefined,
    E extends EventsDef | undefined = undefined,
  >(options: RegisterOptions<I, S, E>): Registered<I, S, E>;
  register(options: RegisterOptions): unknown {
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
    // Local persistence. Before the config registry, which stores its scopes as collections on it.
    const db = createEngineDb(namespace, message => console.warn(message));
    const config = new ConfigRegistry(node, namespace, db);
    const translations = new TranslationsRegistry(node.state, namespace);
    const guides = new GuidesRegistry(node.state, namespace);
    const pages = new PagesRegistry(node.state, namespace);
    const host = new HostElection(registry, namespace);
    const shared = new SharedRegistry({ state: node.state, namespace });
    const events = new EventsRegistry({ events: node.events, namespace });

    this._node = node;
    this._registry = registry;
    this._features = features;
    this._shared = shared;
    this._events = events;
    this._db = db;
    this._config = config;
    this._translations = translations;
    this._guides = guides;
    this._pages = pages;
    this._host = host;

    node.start();
    registry.start();
    features.start();
    config.start();
    translations.start();
    guides.start();
    host.start();

    if (options.translations) { translations.provide(options.translations); }

    if (options.guide) { guides.provideManifest(options.guide); }

    if (options.guideReference) { guides.provideReference(options.guideReference); }

    if (options.page) { pages.provide(options.page); }

    const configTree = options.config ? config.define(options.config) : undefined;
    const sharedTree = options.shared ? shared.define(options.shared) : undefined;
    const eventsTree = options.events ? events.define(options.events) : undefined;

    if (configTree === undefined && sharedTree === undefined && eventsTree === undefined) {
      return undefined;
    }

    return {
      ...(configTree === undefined ? {} : { config: configTree }),
      ...(sharedTree === undefined ? {} : { shared: sharedTree }),
      ...(eventsTree === undefined ? {} : { events: eventsTree }),
    };
  }

  /** Take the addon offline. Safe to call before registering (no-op). */
  stop(): void {
    this._host?.stop();
    this._guides?.stop();
    this._translations?.stop();
    this._config?.stop();
    this._features?.stop();
    this._registry?.stop();
    this._node?.stop();
    this._host = undefined;
    this._pages = undefined;
    this._guides = undefined;
    this._translations = undefined;
    this._config = undefined;
    this._features = undefined;
    this._registry = undefined;
    this._shared = undefined;
    this._events = undefined;
    this._db = undefined;
    this._node = undefined;
    this._manifest = undefined;
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
