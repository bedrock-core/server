/**
 * `@bedrock-core/server-runtime` — the bedrock-core server runtime.
 *
 * An addon registers its identity and everything it declares in one call, and is online. What it
 * declared comes back typed; what other addons declared is reachable through `core.*`.
 *
 * Every field beside `manifest` is a declaration — it installs itself and hands back its accessor,
 * so the runtime carries the addon's types through without knowing what they are:
 *
 * A declaration may come from any package — `config(definition)` is `@bedrock-core/config/server`'s,
 * and the runtime installs it without knowing what it builds.
 *
 * ```ts
 * import { core, event, events, shared } from '@bedrock-core/server-runtime';
 * import { config } from '@bedrock-core/config/server';
 *
 * const declared = core.register({
 *   manifest: {
 *     creator: 'bt',               // creator id, lowercase a-z0-9_
 *     pack: 'gc_shop',             // pack id — together: namespace `bt_gc_shop`
 *     packName: 'My Cool Shop',    // display label only
 *     version: '1.2.0',
 *     dependencies: ['os_economy'],
 *   },
 *   config: config({ server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } }),
 *   shared: shared({ price: 10, sale: { active: false } }),
 *   events: events({ restocked: event<{ item: string }>() }),
 * });
 *
 * declared.config.server.taxRate.get();     // an observable per node, local and synchronous
 * declared.shared.price.set(12);            // every realm reads it this tick
 * declared.events.restocked.emit({ item: 'diamond' });
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
export type { Declared, RegisterOptions, RuntimeSlots } from './runtime';

export type { Declaration } from './declaration';

export { RUNTIME_VERSION } from './runtime-version';

export { Announcement, isRecord } from './announcement';
export type { AnnouncementListener } from './announcement';

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

export { event, events } from './events';
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

export { shared } from './shared';
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

export { authorize, denyReason, isOperator } from './authorization';
export type { AccessTarget, Operation } from './authorization';
