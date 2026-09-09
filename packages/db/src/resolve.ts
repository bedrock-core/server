/**
 * The resolver: given anything, decide where its documents can live.
 *
 * Nothing is declared. The target is probed — does it expose the six-method ABI, does it carry a
 * `minecraft:dynamic_properties` component, or does it hold nothing and need a world property
 * keyed by its identity — and the answer is cached **per type**, because whether a type holds its
 * own properties is a property of the type: `minecraft:block_entity` cannot vary by permutation,
 * and an item's stackability is fixed by its type. A throw is never cached; a block in an
 * unloaded chunk throws on `getComponent`, and caching that would demote a whole block type for
 * the rest of the session.
 *
 * Refusals come first, by name, because the structural test alone would accept the one target
 * where every write is a silent lie: an `ItemStack` is a copy (measured — a stackable one throws,
 * a non-stackable one writes to the copy and a fresh read gives `undefined`).
 */
import {
  componentHost,
  directHost,
  proxiedHost,
  type ComponentDp,
  type DirectDp,
  type DpHost,
} from './host';

/** What a target is, as the classifier sees it. */
export type TargetKind = 'world' | 'dimension' | 'entity' | 'block' | 'slot' | 'itemStack' | 'unknown';

/**
 * How the resolver recognizes targets. The default is structural — it reads members, so it runs
 * without the engine — and `@bedrock-core/db/minecraft` supplies one built on `instanceof`.
 */
export interface Classifier {
  kindOf(target: unknown): TargetKind;
}

/** A resolution that found a host: the target's kind, type, identity and where its bytes live. */
export interface Accepted {
  readonly ok: true;
  readonly kind: TargetKind;
  /** The block or entity type, a slot's item type, a dimension's id, `world`. */
  readonly typeId: string;
  readonly typeKey: string;
  readonly identity: string;
  readonly host: DpHost;
  /**
   * The prefix a collection applies on top of `host` so its keys never meet another
   * collection's, config's, or a proxied document's — the key scheme in one place:
   * `core-db:<ns>:<kind>:<identity>:<collection>:<key>`, the identity empty on an own host
   * because the target *is* the identity, and only `<collection>:` on a block entity, whose
   * ~950 bytes are per pack per block already.
   */
  prefixFor(collection: string): string;
}

/** A resolution that found no host, with the reason. */
export interface Refused {
  readonly ok: false;
  readonly kind: TargetKind;
  readonly reason: string;
}

/** What `resolve()` answers. */
export type Resolution = Accepted | Refused;

/** What `createResolver()` takes. */
export interface ResolverOptions {
  /** The world, for proxied hosts. Anything with the six-method ABI. */
  world: DirectDp;
  /** The addon's namespace — the first segment of every proxied key. */
  namespace: string;
  classify?: Classifier;
}

/** Decides, per target, where a document can live, probing each type once. */
export interface Resolver {
  resolve(target: unknown): Resolution;
  /** The cached decision for a type key, for tests and diagnostics. */
  decision(typeKey: string): 'direct' | 'component' | 'proxied' | undefined;
  /**
   * A resolution for a target that is not at hand — an index entry whose block sits in an unloaded
   * chunk — when its documents live on the world anyway: a dimension always, a block or entity type
   * this session already saw resolve to the proxy. `undefined` when the bytes would be on the target.
   */
  absent(kind: TargetKind, typeId: string, identity: string): Accepted | undefined;
}

// ─── Structural reads, without assertions ─────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === 'string' ? value : undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === 'number' ? value : undefined;
}

function isDirectDp(value: unknown): value is DirectDp {
  return isRecord(value)
    && typeof value.getDynamicProperty === 'function'
    && typeof value.setDynamicProperty === 'function'
    && typeof value.getDynamicPropertyIds === 'function'
    && typeof value.getDynamicPropertyTotalByteCount === 'function';
}

function isComponentDp(value: unknown): value is ComponentDp {
  return isRecord(value)
    && typeof value.get === 'function'
    && typeof value.set === 'function'
    && typeof value.totalByteCount === 'function';
}

function hasGetComponent(value: unknown): value is { getComponent(id: string): unknown } {
  return isRecord(value) && typeof value.getComponent === 'function';
}

/**
 * Recognize a target by the members the engine gives each class and nothing else has:
 * `World.getAllPlayers`, `ItemStack.clone` (a slot mirrors most of a stack's members but not that
 * one), `ContainerSlot.getItem`, `Block.permutation`, `Entity.id` beside the DP methods,
 * `Dimension.getBlock`.
 */
export const structuralClassifier: Classifier = {
  kindOf(target: unknown): TargetKind {
    if (!isRecord(target)) {
      return 'unknown';
    }

    if (typeof target.getAllPlayers === 'function' && typeof target.getDynamicProperty === 'function') {
      return 'world';
    }

    if (typeof target.clone === 'function' && typeof target.getItem !== 'function' && 'maxAmount' in target) {
      return 'itemStack';
    }

    if (typeof target.getItem === 'function' && 'maxAmount' in target) {
      return 'slot';
    }

    if ('permutation' in target && 'location' in target && 'typeId' in target) {
      return 'block';
    }

    if ('typeId' in target && 'id' in target && typeof target.getDynamicProperty === 'function') {
      return 'entity';
    }

    if ('id' in target && typeof target.getBlock === 'function') {
      return 'dimension';
    }

    return 'unknown';
  },
};

// ─── Identity ──────────────────────────────────────────────────────────────────

function identityOf(target: Record<string, unknown>, kind: TargetKind): string {
  switch (kind) {
    case 'world':
      return '';
    case 'dimension':
    case 'entity':
      return str(target, 'id') ?? '';

    // Dimension, position AND type: a block of another type at the same position gets a different
    // key, so a replacement can never inherit a document — the type check is in the key, not on read.
    case 'block': {
      const dimension = target.dimension;
      const location = target.location;
      const dimensionId = isRecord(dimension) ? str(dimension, 'id') ?? '' : '';
      const typeId = str(target, 'typeId') ?? '?';

      if (!isRecord(location)) {
        return `${dimensionId}::${typeId}`;
      }

      return `${dimensionId}:${num(location, 'x') ?? 0},${num(location, 'y') ?? 0},${num(location, 'z') ?? 0}:${typeId}`;
    }

    default:
      return '';
  }
}

function typeIdOf(target: Record<string, unknown>, kind: TargetKind): string {
  switch (kind) {
    case 'block':
    case 'entity':
      return str(target, 'typeId') ?? '?';

    case 'slot': {
      const item = typeof target.getItem === 'function' ? target.getItem() : undefined;

      return isRecord(item) ? str(item, 'typeId') ?? '?' : 'empty';
    }

    case 'dimension':
      return str(target, 'id') ?? '?';

    default:
      return kind;
  }
}

/** The cache key for a resolver decision: per type where the type decides, one per kind otherwise. */
function typeKeyOf(kind: TargetKind, typeId: string): string {
  switch (kind) {
    case 'block':
    case 'entity':
    case 'slot':
      return `${kind}:${typeId}`;

    default:
      return kind;
  }
}

// ─── The resolver ──────────────────────────────────────────────────────────────

type Decision
  = | { abi: 'direct'; batch: boolean }
    | { abi: 'component' }
    | { abi: 'proxied' };

const PROXIED: Decision = { abi: 'proxied' };
const COMPONENT: Decision = { abi: 'component' };
const DIRECT_BATCH: Decision = { abi: 'direct', batch: true };
const DIRECT_SINGLE: Decision = { abi: 'direct', batch: false };

class AcceptedResolution implements Accepted {
  readonly ok = true;
  readonly typeKey: string;

  constructor(
    readonly kind: TargetKind,
    readonly typeId: string,
    readonly identity: string,
    readonly host: DpHost,
    private readonly _namespace: string,
  ) {
    this.typeKey = typeKeyOf(kind, typeId);
  }

  prefixFor(collection: string): string {
    return this.host.abi === 'direct'
      ? `core-db:${this._namespace}:${this.kind}::${collection}:`
      : `${collection}:`;
  }
}

/** A resolver over any world with the six-method ABI and any classifier. */
export function createResolver(options: ResolverOptions): Resolver {
  const classify = options.classify ?? structuralClassifier;
  const { namespace, world } = options;
  const decisions = new Map<string, Decision>();

  const proxied = (kind: TargetKind, typeId: string, identity: string): Accepted =>
    new AcceptedResolution(kind, typeId, identity, proxiedHost(world, `core-db:${namespace}:${kind}:${identity}:`), namespace);

  const direct = (kind: TargetKind, typeId: string, identity: string, target: DirectDp, batch: boolean): Accepted =>
    new AcceptedResolution(kind, typeId, identity, directHost(target, { readableWhenUnloaded: kind === 'world', batch }), namespace);

  const refuse = (kind: TargetKind, reason: string): Refused => ({ ok: false, kind, reason });

  const resolve = (target: unknown): Resolution => {
    const kind = classify.kindOf(target);

    if (!isRecord(target)) {
      return refuse(kind, 'not an object');
    }

    if (kind === 'itemStack') {
      return refuse(kind, 'an ItemStack is a detached copy — a write never reaches the world; bind the ContainerSlot it lives in');
    }

    if (kind === 'unknown') {
      return refuse(kind, 'not a target the resolver recognizes');
    }

    const identity = identityOf(target, kind);
    const typeId = typeIdOf(target, kind);
    const typeKey = typeKeyOf(kind, typeId);

    if (kind === 'slot') {
      const item = typeof target.getItem === 'function' ? target.getItem() : undefined;

      if (!isRecord(item)) {
        return refuse(kind, 'the slot is empty');
      }

      if ((num(item, 'maxAmount') ?? 64) !== 1) {
        return refuse(kind, `a stackable item (${str(item, 'typeId') ?? '?'}) cannot hold dynamic properties`);
      }
    }

    // A type decided once is trusted: whether it holds its own properties, and how, cannot change.
    const cached = decisions.get(typeKey);

    if (cached !== undefined) {
      switch (cached.abi) {
        case 'direct':
          return direct(kind, typeId, identity, target as unknown as DirectDp, cached.batch); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

        case 'proxied':
          return proxied(kind, typeId, identity);

        case 'component': {
          const component = probeComponent(target);

          if (component === undefined) {
            return refuse(kind, 'cannot probe right now: the target is not loaded');
          }

          return new AcceptedResolution(kind, typeId, identity, componentHost(component), namespace);
        }
      }
    }

    // Direct ABI first: it wins where both are present (a block item has the component too).
    if (isDirectDp(target)) {
      const batch = typeof target.setDynamicProperties === 'function';

      decisions.set(typeKey, batch ? DIRECT_BATCH : DIRECT_SINGLE);

      return direct(kind, typeId, identity, target, batch);
    }

    // Component ABI: probe, and never cache a throw — an unloaded chunk throws here.
    if (hasGetComponent(target)) {
      let component: unknown;

      try {
        component = target.getComponent('minecraft:dynamic_properties');
      } catch (error) {
        return refuse(kind, `cannot probe right now: ${String(error)}`);
      }

      if (isComponentDp(component)) {
        decisions.set(typeKey, COMPONENT);

        return new AcceptedResolution(kind, typeId, identity, componentHost(component), namespace);
      }
    }

    decisions.set(typeKey, PROXIED);

    return proxied(kind, typeId, identity);
  };

  return {
    resolve,
    decision: typeKey => decisions.get(typeKey)?.abi,
    absent: (kind, typeId, identity): Accepted | undefined => {
      const decided = kind === 'dimension' ? 'proxied' : decisions.get(typeKeyOf(kind, typeId))?.abi;

      return decided === 'proxied' ? proxied(kind, typeId, identity) : undefined;
    },
  };
}

/** The component of a block whose type is known to have one; `undefined` while its chunk is unloaded. */
function probeComponent(target: Record<string, unknown>): ComponentDp | undefined {
  if (!hasGetComponent(target)) {
    return undefined;
  }

  try {
    const component = target.getComponent('minecraft:dynamic_properties');

    return isComponentDp(component) ? component : undefined;
  } catch {
    return undefined;
  }
}
