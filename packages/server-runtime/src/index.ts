export { core, Runtime } from './runtime';
export type { Declared, RegisterOptions, RuntimeSlots } from './runtime';

export type { Declaration } from './declaration';

export { RUNTIME_VERSION } from './runtime-version';

export { Announcement, isRecord } from './announcement';
export type { AnnouncementListener } from './announcement';

export type { HostElection, HostListener } from './host';

export type { IncompatibleListener, IncompatiblePeer } from '@bedrock-core/sync';
export type { AddonListener, CollisionListener, RegisteredAddon, Registry } from './registry';

export type { FeatureConditionContext, FeatureFlags, FeatureManager, FeatureSpec, TypedFeatureAccessor } from './features';

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

export { event, registerEvents } from './events';
export type {
  EventListener,
  EventMarker,
  EventsDef,
  EventsRegistry,
  EventsTree,
  OwnEvent,
  PayloadOf,
  PeerEvent,
  PeerEventsTree,
} from './events';

export { registerShared } from './shared';
export type {
  PeerSharedTree,
  PeerValue,
  Shape,
  SharedDef, SharedRegistry, SharedTree,
  SharedValue,
} from './shared';

export type { AddonManifest, ManifestMeta } from './manifest';

export type { RPCHandlerMap, TypedClient } from '@bedrock-core/sync';

export { isUsable, type EngineHandle } from './handle';

export type { I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
export type { TranslationsRegistry } from './translations';

export { authorize, denyReason, isOperator } from './authorization';
export type { AccessTarget, Operation } from './authorization';
