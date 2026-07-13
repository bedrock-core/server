/**
 * The bedrock-core server runtime.
 *
 * An addon registers itself once — that's it. {@link Runtime.register} validates the manifest
 * and immediately brings the addon online (no separate `start()`). The runtime wraps a single
 * sync `SyncNode` and exposes the cross-addon {@link Registry}, the {@link FeatureManager},
 * and messaging/state passthroughs.
 *
 * The default export is the `core` singleton — `import { core } from '@bedrock-core/server-runtime'`.
 * The `Runtime` class stands alone, so tests (and GameTests) can create several runtimes in one
 * script realm; they all talk over the real `system` script-event bus.
 */
import { SyncNode } from '@bedrock-core/sync';
import { addonTransportId, type AddonManifest, manifestToMeta, validateManifest } from './manifest';
import { FeatureManager, type FeatureSpec } from './features';
import { Registry } from './registry';
import { ScopedState } from './scoped-state';
import { ConfigRegistry } from './config/config-registry';
import { TranslationsRegistry } from './translations';
import { GuidesRegistry } from './guides/guides-registry';
import type { GuideManifest } from './guides/types';
import type { Rpc } from '@bedrock-core/sync';

export class Runtime {
  private _node: SyncNode | undefined;
  private _registry: Registry | undefined;
  private _features: FeatureManager | undefined;
  private _manifest: AddonManifest | undefined;
  private _state: ScopedState | undefined;
  private _config: ConfigRegistry | undefined;
  private _translations: TranslationsRegistry | undefined;
  private _guides: GuidesRegistry | undefined;

  /** Whether the addon has been registered (and is therefore live). */
  get registered(): boolean {
    return this._manifest !== undefined;
  }

  /** This addon's unique transport id: `creator:namespace` (e.g. `drav0011:bc_economy`). Use this for RPC targeting. */
  get id(): string {
    return addonTransportId(this.requireManifest());
  }

  /** This addon's namespace (e.g. `bc_economy`). Use this for state keys and dependency declarations. */
  get namespace(): string {
    return this.requireManifest().namespace;
  }

  /** This addon's manifest. */
  get manifest(): AddonManifest {
    return this.requireManifest();
  }

  /** The cross-addon registry. */
  get registry(): Registry {
    return this.require(this._registry, 'registry');
  }

  /** The feature manager — use `core.feature()` to declare features, `core.features.of()` for cross-addon reads. */
  get features(): FeatureManager {
    return this.require(this._features, 'features');
  }

  /** The config registry — call `core.config.define()` to declare this addon's config. */
  get config(): ConfigRegistry {
    return this.require(this._config, 'config');
  }

  /** Cross-addon translation keys — call `core.translations.provide()` to publish this addon's keys, `all()` for the merged map. */
  get translations(): TranslationsRegistry {
    return this.require(this._translations, 'translations');
  }

  /** Cross-addon guides — call `core.guide()` to publish this addon's guide, `core.guides.of()` for cross-addon reads. */
  get guides(): GuidesRegistry {
    return this.require(this._guides, 'guides');
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
   */
  register(manifest: AddonManifest): void {
    if (this._manifest) { throw new Error('runtime is already registered'); }

    const validated = validateManifest(manifest);

    this._manifest = validated;

    const node = new SyncNode({
      id: addonTransportId(validated),
      version: validated.version,
      meta: manifestToMeta(validated),
      // Own the transport-id namespace too: config and translations publish under it, and
      // only owned namespaces are answered in sync's late-join snapshot exchange.
      ownedNamespaces: [validated.namespace, addonTransportId(validated)],
    });
    const registry = new Registry(node.discovery, validated);
    const features = new FeatureManager(registry, node.state, addonTransportId(validated));
    const config = new ConfigRegistry(node, addonTransportId(validated));
    const translations = new TranslationsRegistry(node.state, addonTransportId(validated));
    const guides = new GuidesRegistry(node.state, addonTransportId(validated));

    this._node = node;
    this._registry = registry;
    this._features = features;
    this._state = new ScopedState(node.state, validated.namespace);
    this._config = config;
    this._translations = translations;
    this._guides = guides;

    node.start();
    registry.start();
    features.start();
    config.start();
    translations.start();
    guides.start();
  }

  /** Take the addon offline. Safe to call before registering (no-op). */
  stop(): void {
    this._guides?.stop();
    this._translations?.stop();
    this._config?.stop();
    this._features?.stop();
    this._registry?.stop();
    this._node?.stop();
    this._guides = undefined;
    this._translations = undefined;
    this._config = undefined;
    this._features = undefined;
    this._registry = undefined;
    this._state = undefined;
    this._node = undefined;
    this._manifest = undefined;
  }

  /**
   * Declare a togglable feature that auto-enables when its required namespaces are all present
   * and auto-disables when any drops out.
   */
  feature(id: string, spec: FeatureSpec): void {
    this.require(this._features, 'features').add(id, spec);
  }

  /**
   * Register this addon's guide: the compiled {@link GuideManifest} (from
   * `@bedrock-core/generated/guides`), replicated cross-addon so the first-wins host can render
   * it. Call once after `register()`; calling again replaces it.
   */
  guide(manifest: GuideManifest): void {
    this.guides.provideManifest(manifest);
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
