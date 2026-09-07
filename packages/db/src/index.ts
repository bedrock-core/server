/**
 * `@bedrock-core/db` — persisted documents on dynamic properties.
 *
 * The resolver finds where a target can hold bytes — its own properties through one of the
 * engine's two ABIs, or a world property keyed by its identity when it holds nothing — and caches
 * the answer per type. Collections put typed, versioned JSON documents on whatever the resolver
 * finds, refuse targets that cannot satisfy their requirements, and never trust a handle past the
 * call it arrived in. Everything in this entry is structural and runs without the engine; the
 * `./minecraft` entry adds the `instanceof` classifier, the locator, and the world.
 */
export {
  COMPONENT_BUDGET,
  DIRECT_BUDGET,
  componentHost,
  directHost,
  prefixed,
  proxiedHost,
} from './host';
export type { Capabilities, ComponentDp, DirectDp, DpHost, DpValue, HostAbi } from './host';

export { createResolver, structuralClassifier } from './resolve';
export type { Classifier, Resolution, Resolver, ResolverOptions, TargetKind } from './resolve';

export { createDb, parseBlockIdentity, structuralLocator } from './collection';
export type { Collection, CollectionOptions, Db, DbOptions, Document, IndexedDocument, Lifecycle, Locator, Where } from './collection';

export { createIndexSet } from './indexed';
export type { IndexSet } from './indexed';

export { createDocumentStore, schema } from './document';
export type { DocumentSchema, DocumentStore, DocumentStoreOptions, MigrateStep, Schema } from './document';

export { accepting, accepts, allOf, anyOf, blockTypes, dimensions, entityTypes, except, players, slots, worldTarget } from './accept';
export type { Acceptor, Caps, Conflicts, Requirements, Rule, StorableTarget } from './accept';

export { DbBudgetError, DbTargetError } from './errors';
