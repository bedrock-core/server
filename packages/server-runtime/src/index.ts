/**
 * `@bedrock-core/server-runtime` — the bedrock-core server runtime.
 *
 * Addons register their identity + base data with the runtime, which flows into a
 * cross-addon registry built on `@bedrock-core/sync`. Typical usage:
 *
 * ```ts
 * import { core } from '@bedrock-core/server-runtime';
 * import bundle from '@bedrock-core/generated/i18n';
 * import guides from '@bedrock-core/generated/guides';
 *
 * // register() brings the addon online — there is no separate start(). Everything the
 * // addon declares rides in the one call; translations/guide/config are all optional.
 * const { config } = core.register({
 *   manifest: {
 *     creator: 'bt',               // creator/vendor id, lowercase a-z0-9_
 *     pack: 'gc_shop',             // abbreviated pack id — together: namespace `bt_gc_shop`
 *     packName: 'My Cool Shop',    // display label only
 *     version: '1.2.0',
 *     dependencies: ['os_economy'],                   // namespaces (`creator_pack`)
 *     optionalDependencies: ['os_leaderboards'],
 *   },
 *   translations: bundle,          // the i18n filter's bundle, shared with other addons' UIs
 *   guide: guides,                 // compiled guide manifest from the guides filter
 *   config: { server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
 * });
 *
 * config.server.get().taxRate;     // typed accessors, same as core.config.define()'s return
 * core.registry.onRegister(addon => console.warn('registered', addon.id));
 * core.registry.onNamespaceCollision(info => console.error('collision', info.id));
 * core.features.add('leaderboard-sync', {
 *   condition: ctx => ctx.registry.has('os_leaderboards'),
 *   onEnable() { console.warn('leaderboards available'); },
 *   onDisable() { console.warn('leaderboards gone'); },
 * });
 * core.rpc.onRequest('buy', params => purchase(params));
 *
 * // The shared mirror, typed: declare the shape, every realm reads it, this one writes it.
 * const { config, shared, events } = core.register({
 *   manifest, config: configDef,
 *   shared: { price: 10, sale: { active: false } },
 *   events: { restocked: event<{ item: string }>() },
 * });
 * shared.price.set(12);
 * core.shared.of<typeof otherAddonShared>('os_shop')?.stock.subscribe(n => hud.set(n));
 *
 * // Events: announced once, kept by nobody. A listener may attach before the addon exists.
 * events.restocked.emit({ item: 'diamond' });
 * core.events.of<typeof otherAddonEvents>('os_shop').sale.subscribe(({ item }) => hud.flash(item));
 * ```
 */
export { Runtime, core } from './runtime';
export type { RegisterOptions, Registered } from './runtime';

export { RUNTIME_VERSION } from './runtime-version';

export { compareVersions } from './version';

export { HostElection } from './host';
export type { HostListener } from './host';

export { Registry } from './registry';
export type { RegisteredAddon, AddonListener, CollisionListener } from './registry';

export { FeatureManager } from './features';
export type { FeatureSpec, FeatureConditionContext, TypedFeatureAccessor } from './features';

// What an addon needs to declare a collection on `core.db`; the package itself is the source for the rest.
export {
  accepting,
  allOf,
  anyOf,
  blockTypes,
  DbBudgetError,
  DbTargetError,
  dimensions,
  entityTypes,
  except,
  players,
  schema,
  slots,
  worldTarget,
} from '@bedrock-core/db';
export type { Collection, Db, Document, IndexedDocument, Schema } from '@bedrock-core/db';

export { EventsRegistry, event } from './events';
export type {
  EventListener,
  EventMarker,
  EventsDef,
  EventsTree,
  OwnEvent,
  PayloadOf,
  PeerEvent,
  PeerEventsTree,
} from './events';

export { SharedRegistry, SHARED_SHAPE_KEY } from './shared';
export type {
  PeerSharedTree,
  PeerValue,
  Shape,
  SharedDef,
  SharedTree,
  SharedValue,
} from './shared';

export { addonNamespace, validateManifest } from './manifest';
export type { AddonManifest, ManifestMeta } from './manifest';

export type { TypedClient, RPCHandlerMap } from '@bedrock-core/sync';
export type { IncompatibleListener, IncompatiblePeer } from '@bedrock-core/sync';
export { PROTOCOL_MAX, PROTOCOL_MIN } from '@bedrock-core/sync';

export { type EngineHandle, isUsable } from './handle';
export { TranslationsRegistry } from './translations';
export type { TranslationsChangeListener } from './translations';
export type { I18nBundle, TranslationResolver } from '@bedrock-core/i18n';

export { GuidesRegistry } from './guides/guides-registry';
export type { GuidesChangeListener } from './guides/guides-registry';
export type { GuideManifest, GuideReference } from './guides/types';
export type { AddonPageReference } from './pages/pages-registry';

export { CONFIG_COLLECTIONS, ConfigRegistry, configMethod } from './config/config-registry';
export type { Config, ConfigAccessOptions, LocalConfigScopes, RemoteConfigAccessor, TypedRemoteConfig } from './config/config-registry';
export { authorize, denyReason, isOperator } from './authorization';
export type { AccessTarget, Operation } from './authorization';
export { EntityScope } from './config/scopes';
export type {
  ChangeListener,
  ScopeTree,
  ConfigTree,
  ConfigNode,
  ConfigChildren,
  ConfigGroupAccessor,
  ConfigLeafAccessor,
  NodeValue,
} from './config/scopes';
export { coerce, defaultsOf, normalizeAgainst } from './config/document';
export type { ConfigDocument } from './config/document';
export { RESERVED_KEYS, flattenGroups, flattenSchema, isGroupMetaKey, validateConfigSchema } from './config/schema';
export type {
  ConfigDefinition,
  ConfigEntry,
  ConfigValue,
  BooleanEntry,
  NumberEntry,
  StringEntry,
  EnumEntry,
  ListEntry,
  MultiselectEntry,
  FlatSchema,
  FlatGroups,
  GroupMeta,
  SerializedEntry,
  SerializedGroup,
  SchemaToValue,
  DeepPartial,
  ConfigScopeName,
} from './config/schema';
