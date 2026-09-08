/**
 * `@bedrock-core/server-runtime` — the bedrock-core server runtime.
 *
 * An addon registers its identity and everything it declares in one call, and is online. What it
 * declared comes back typed; what other addons declared is reachable through `core.*`:
 *
 * ```ts
 * import { core, event } from '@bedrock-core/server-runtime';
 * import bundle from '@bedrock-core/generated/i18n';
 *
 * const { config, shared, events } = core.register({
 *   manifest: {
 *     creator: 'bt',               // creator id, lowercase a-z0-9_
 *     pack: 'gc_shop',             // pack id — together: namespace `bt_gc_shop`
 *     packName: 'My Cool Shop',    // display label only
 *     version: '1.2.0',
 *     dependencies: ['os_economy'],
 *   },
 *   translations: bundle,          // the i18n filter's bundle, resolvable by other addons' UIs
 *   config: { server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
 *   shared: { price: 10, sale: { active: false } },
 *   events: { restocked: event<{ item: string }>() },
 * });
 *
 * config.server.taxRate.get();     // an observable per node, local and synchronous
 * shared.price.set(12);            // every realm reads it this tick
 * events.restocked.emit({ item: 'diamond' });
 *
 * core.shared.of<typeof otherShared>('os_shop')?.stock.subscribe(n => hud.set(n));
 * core.events.of<typeof otherEvents>('os_shop').sale.subscribe(({ item }) => hud.flash(item));
 * core.features.add('leaderboard-sync', {
 *   condition: ctx => ctx.registry.has('os_leaderboards'),
 *   onEnable() { console.warn('leaderboards available'); },
 *   onDisable() { console.warn('leaderboards gone'); },
 * });
 * core.rpc.onRequest('buy', params => purchase(params));
 * ```
 */
export { Runtime, core } from './runtime';
export type { RegisterOptions, Registered } from './runtime';

export { RUNTIME_VERSION } from './runtime-version';

export type { Announcement, AnnouncementListener } from './announcement';

export type { HostElection, HostListener } from './host';

export type { Registry, RegisteredAddon, AddonListener, CollisionListener } from './registry';
export type { IncompatibleListener, IncompatiblePeer } from '@bedrock-core/sync';

export type { FeatureManager, FeatureFlags, FeatureSpec, FeatureConditionContext, TypedFeatureAccessor } from './features';

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

export { event } from './events';
export type {
  EventsRegistry,
  EventListener,
  EventMarker,
  EventsDef,
  EventsTree,
  OwnEvent,
  PayloadOf,
  PeerEvent,
  PeerEventsTree,
} from './events';

export type {
  SharedRegistry,
  PeerSharedTree,
  PeerValue,
  Shape,
  SharedDef,
  SharedTree,
  SharedValue,
} from './shared';

export type { AddonManifest, ManifestMeta } from './manifest';

export type { TypedClient, RPCHandlerMap } from '@bedrock-core/sync';

export { type EngineHandle, isUsable } from './handle';

export type { TranslationsRegistry } from './translations';
export type { I18nBundle, TranslationResolver } from '@bedrock-core/i18n';

export type { GuidesRegistry, GuideManifest, GuideReference } from './guides';
export type { AddonPageReference } from './pages';

export type { ConfigRegistry, Config, ConfigAccessOptions, LocalConfigScopes, RemoteConfigAccessor, TypedRemoteConfig } from './config/config-registry';
export { authorize, denyReason, isOperator } from './authorization';
export type { AccessTarget, Operation } from './authorization';
export type {
  EntityScope,
  ChangeListener,
  ScopeTree,
  ConfigTree,
  ConfigNode,
  ConfigChildren,
  ConfigGroupAccessor,
  ConfigLeafAccessor,
  NodeValue,
} from './config/scopes';
export type { ConfigDocument } from './config/document';
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
