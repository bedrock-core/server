export { core, Runtime } from './runtime';
export type { Declared, RegisterOptions, RuntimeSlots } from './runtime';

export type { Declaration } from './declaration';
export type { Codec } from './api/types';
export { registerApi, type ApiDeclaration } from './api/declaration';

export { RUNTIME_VERSION } from './manifest';

export { isRecord } from './guards';

export type { HostElection, HostListener } from './host';

export type { AddonListener, CollisionListener, RegisteredAddon, Registry } from './registry';

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

export type { AddonManifest } from './manifest';

export { isUsable, type EngineHandle } from './handle';

export type { I18nBundle, TranslationResolver } from '@bedrock-core/i18n';
export type { TranslationsRegistry } from './translations';

export { authorize, denyReason, isOperator } from './authorization';
export type { AccessTarget, Operation } from './authorization';
