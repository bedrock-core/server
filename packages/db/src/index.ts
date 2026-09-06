/**
 * `@bedrock-core/db` — persisted documents on dynamic properties.
 *
 * The resolver finds where a target can hold bytes — its own properties through one of the
 * engine's two ABIs, or a world property keyed by its identity when it holds nothing — and caches
 * the answer per type. Everything in this entry is structural and runs without the engine; the
 * `./minecraft` entry adds the `instanceof` classifier and the world.
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
