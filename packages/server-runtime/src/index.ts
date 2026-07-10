/**
 * `@bedrock-core/server-runtime` — the bedrock-core server runtime.
 *
 * Addons register their identity + base data with the runtime, which flows into a
 * cross-addon registry built on `@bedrock-core/sync`. Typical usage:
 *
 * ```ts
 * import { core } from '@bedrock-core/server-runtime';
 *
 * // register() brings the addon online — there is no separate start().
 * core.register({
 *   creator: 'my_studio',          // creator/vendor id
 *   namespace: 'bc_shop',          // unique id, lowercase a-z0-9_
 *   name: 'My Cool Shop',          // display label only
 *   version: '1.2.0',
 *   dependencies: ['bc_economy'],
 *   optionalDependencies: ['bc_leaderboards'],
 * });
 *
 * core.registry.onRegister(addon => console.warn('registered', addon.id));
 * core.registry.onNamespaceCollision(info => console.error('collision', info.id));
 * core.feature('leaderboard-sync', {
 *   condition: r => r.has('other_studio:bc_leaderboards'),
 *   onEnable() { console.warn('leaderboards available'); },
 *   onDisable() { console.warn('leaderboards gone'); },
 * });
 * core.rpc.onRequest('buy', params => purchase(params));
 * core.state.set('price', 10);   // namespace pre-filled from core.id
 * ```
 */
export { Runtime, core } from './runtime';

export { Registry } from './registry';
export type { RegisteredAddon, AddonListener, CollisionListener } from './registry';

export { FeatureManager } from './features';
export type { FeatureSpec, FeatureConditionContext, TypedFeatureAccessor } from './features';

export { ScopedState } from './scoped-state';

export { validateManifest } from './manifest';
export type { AddonManifest, ManifestMeta } from './manifest';

export type { TypedClient, RPCHandlerMap } from '@bedrock-core/sync';

export { TranslationsRegistry, TRANSLATIONS_STATE_KEY } from './translations';
export type { TranslationsChangeListener } from './translations';

export { ConfigRegistry } from './config/config-registry';
export type { Config, RemoteConfigAccessor, TypedRemoteConfig } from './config/config-registry';
export { EntityConfigScope } from './config/scopes';
export { ServerConfigScope } from './config/scopes';
export type {
  ConfigDefinition,
  ConfigEntry,
  ConfigValue,
  BooleanEntry,
  NumberEntry,
  StringEntry,
  EnumEntry,
  ListEntry,
  FlatSchema,
  SerializedEntry,
  SchemaToValue,
  DotPath,
  PathValue,
  DeepPartial,
} from './config/schema';
