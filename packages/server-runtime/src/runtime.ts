/**
 * The bedrock-core server runtime.
 *
 * An addon registers itself once — that's it. {@link Runtime.register} validates the manifest
 * and immediately brings the addon online (no separate `start()`). Everything the addon
 * *declares* rides in that one call: identity, plus the optional `translations`, `guide`, and
 * `config` fields (see {@link RegisterOptions}). The runtime wraps a single sync `SyncNode`
 * and exposes the cross-addon {@link Registry}, the {@link FeatureManager}, and
 * messaging/state passthroughs.
 *
 * The default export is the `core` singleton — `import { core } from '@bedrock-core/server-runtime'`.
 * The `Runtime` class stands alone, so tests (and GameTests) can create several runtimes in one
 * script realm; they all talk over the real `system` script-event bus.
 */
import { SyncNode } from '@bedrock-core/sync';
import { addonNamespace, type AddonManifest, manifestToMeta, validateManifest } from './manifest';
import { FeatureManager } from './features';
import { Registry } from './registry';
import { ScopedState } from './scoped-state';
import { ConfigRegistry, type Config } from './config/config-registry';
import type { ConfigDefinition } from './config/schema';
import type { I18nBundle } from '@bedrock-core/i18n';
import { TranslationsRegistry } from './translations';
import { GuidesRegistry } from './guides/guides-registry';
import { HostElection } from './host';
import type { GuideManifest } from './guides/types';
import type { Rpc } from '@bedrock-core/sync';

/**
 * Everything an addon declares when it registers: the identity manifest plus the optional
 * cross-addon data. One bag — "tell core what you are" — then run your own code. Each optional
 * field is sugar for the corresponding post-register call and behaves identically:
 *
 * - `translations` → `core.translations.provide()`
 * - `guide` → `core.guides.provideManifest()`
 * - `config` → `core.config.define()` (its typed accessors become `register()`'s return value)
 *
 * The standalone calls remain available for addons that need to publish late or replace data
 * at runtime.
 */
export interface RegisterOptions<I extends ConfigDefinition = ConfigDefinition> extends AddonManifest {

  /**
   * This addon's i18n bundle (`@bedrock-core/generated/i18n`, or a
   * `createResourceBundle` result), published to replicated state so other
   * addons' UIs can resolve and measure its strings — and get verbs over them
   * via `core.translations.of()`.
   */
  translations?: I18nBundle;

  /** This addon's compiled guide manifest (`@bedrock-core/generated/guides`), published for the elected host to render. */
  guide?: GuideManifest;

  /** This addon's config schema. When given, `register()` returns the typed scope accessors. */
  config?: I;
}

export class Runtime {
  private _node: SyncNode | undefined;
  private _registry: Registry | undefined;
  private _features: FeatureManager | undefined;
  private _manifest: AddonManifest | undefined;
  private _state: ScopedState | undefined;
  private _config: ConfigRegistry | undefined;
  private _translations: TranslationsRegistry | undefined;
  private _guides: GuidesRegistry | undefined;
  private _host: HostElection | undefined;

  /** Whether the addon has been registered (and is therefore live). */
  get registered(): boolean {
    return this._manifest !== undefined;
  }

  /**
   * This addon's namespace: `creator_pack` (e.g. `bt_gc_economy`).
   *
   * The one identifier it is known by — RPC targeting, state keys, dependency declarations,
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
  get guides(): GuidesRegistry {
    return this.require(this._guides, 'guides');
  }

  /** Host election — `core.host.isHost` tells you whether this realm should do the work only one realm may do (e.g. render the shared UI). */
  get host(): HostElection {
    return this.require(this._host, 'host');
  }

  /** Replicated state scoped to this addon's namespace — no need to pass the namespace on every call. For cross-namespace reads use `core.node.state`. */
  get state(): ScopedState {
    return this.require(this._state, 'state');
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
   * `translations`, `guide`, and `config` (see {@link RegisterOptions}). When `config` is
   * given, the typed scope accessors are returned — the same value `core.config.define()`
   * would return.
   */
  register<I extends ConfigDefinition>(options: RegisterOptions<I> & { config: I }): Config<I>;
  register(options: RegisterOptions): void;
  register<I extends ConfigDefinition>(options: RegisterOptions<I>): Config<I> | undefined {
    if (this._manifest) { throw new Error('runtime is already registered'); }

    // validateManifest() copies only the identity fields, so the extra declaration
    // fields never leak into the stored manifest or the discovery meta blob.
    const validated = validateManifest(options);

    this._manifest = validated;

    // One namespace for everything this addon owns — transport id, state, config, guides.
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
    const config = new ConfigRegistry(node, namespace);
    const translations = new TranslationsRegistry(node.state, namespace);
    const guides = new GuidesRegistry(node.state, namespace);
    const host = new HostElection(registry, namespace);

    this._node = node;
    this._registry = registry;
    this._features = features;
    this._state = new ScopedState(node.state, namespace);
    this._config = config;
    this._translations = translations;
    this._guides = guides;
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

    return options.config ? config.define(options.config) : undefined;
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
    this._guides = undefined;
    this._translations = undefined;
    this._config = undefined;
    this._features = undefined;
    this._registry = undefined;
    this._state = undefined;
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
