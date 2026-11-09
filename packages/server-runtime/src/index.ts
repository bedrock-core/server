export { core, Runtime } from './runtime';
export type { Declared, RegisterOptions } from './runtime';

/**
 * Local services keyed by their owning library's namespaced service name.
 * Libraries augment this public module and manage absence through their accessors.
 *
 * ```ts
 * declare module '@bedrock-core/server-runtime' {
 *   interface RuntimeServices { 'acme:widgets': WidgetService }
 * }
 * ```
 *
 * Declarations register services through Runtime.provideService and retrieve them
 * through Runtime.service. Services remain local to each Runtime instance.
 */
export interface RuntimeServices {}

export type { Declaration, Installation, InstallationLifetime } from './library';
export type { Codec } from './api/types';
export { registerModule, type ModuleDeclaration } from './api/declaration';

export { RUNTIME_VERSION } from './manifest';

export { isRecord } from './guards';

export type { AddonListener, CollisionListener, RegisteredAddon, AddonRegistry } from './registries/addons';
export type { RegistryDescriptor, RegistryMinecraftCoverage } from './registries/descriptor';

export type { AddonManifest } from './manifest';

export { isUsable, type EngineHandle } from './handle';

export type { I18nBundle, TranslationResolver } from '@bedrock-core/i18n';

export { authorize, denyReason, isOperator } from './authorization';
export type { AccessTarget, Operation } from './authorization';
