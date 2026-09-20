/**
 * Acceptors: what a collection takes in `for()`, checked twice.
 *
 * At compile time an acceptor is branded with the target type, so a block collection refuses a
 * `Player` in the IDE, and `require` is compared against what that type can *possibly* do — a
 * `Dimension` never holds its own properties, so `require: { own: true }` on a dimension collection
 * is a type error whose message is the property name the checker asks for. At runtime the acceptor
 * is a cheap predicate asked once per target type and cached beside the resolver's decision.
 *
 * Only `import type` touches the engine here: the types are erased, so this file runs in vitest.
 */
import type { Block, ContainerSlot, Dimension, Entity, ItemStack, Player, World } from '@minecraft/server';
import type { TargetKind } from './resolve';

/** Anything the resolver can host. The default target when a collection declares no `accept`. */
export type StorableTarget = World | Dimension | Entity | Block | ContainerSlot;

declare const targetBrand: unique symbol;

/**
 * A rule over target types. `kinds` narrows first so a block acceptor never sees an entity; `test`
 * is asked with the type id (block or entity type, item type of a slot, `minecraft:overworld` for
 * a dimension, `world` for the world). Types, not instances: the answer is cached per type beside
 * the resolver's decision, which is what makes the check free on the hot path.
 */
export interface Acceptor<T> extends Rule {
  /** The brand, invariant so `Acceptor<Player>` never passes where any storable target is meant. */
  readonly [targetBrand]?: (target: T) => T;
}

/** An acceptor without its brand — what the runtime reads, and what compositions take. */
export interface Rule {
  readonly kinds: readonly TargetKind[];
  test(typeId: string, kind: TargetKind): boolean;
}

function acceptor<T>(kinds: readonly TargetKind[], test: (typeId: string, kind: TargetKind) => boolean): Acceptor<T> {
  return { kinds, test };
}

const ALL_KINDS: readonly TargetKind[] = ['world', 'dimension', 'entity', 'block', 'slot'];

/** Does this acceptor take a target of `kind` with `typeId` — kinds first, then the rule. */
export function accepts(acceptor: Rule, typeId: string, kind: TargetKind): boolean {
  return acceptor.kinds.includes(kind) && acceptor.test(typeId, kind);
}

const any = (): boolean => true;

const listed = (ids: readonly string[]): ((typeId: string) => boolean) => {
  if (ids.length === 0) {
    return any;
  }

  const set = new Set(ids);

  return (typeId): boolean => set.has(typeId);
};

/** Blocks of the listed types; every block when none is listed. */
export function blockTypes(...ids: string[]): Acceptor<Block> {
  return acceptor(['block'], listed(ids));
}

/** Entities of the listed types; every entity, players included, when none is listed. */
export function entityTypes(...ids: string[]): Acceptor<Entity> {
  return acceptor(['entity'], listed(ids));
}

/** Players only. */
export function players(): Acceptor<Player> {
  return acceptor(['entity'], typeId => typeId === 'minecraft:player');
}

/** Container slots holding a non-stackable item of the listed types; any non-stackable item when none is listed. */
export function slots(...itemIds: string[]): Acceptor<ContainerSlot> {
  return acceptor(['slot'], listed(itemIds));
}

/** The world. */
export function worldTarget(): Acceptor<World> {
  return acceptor(['world'], any);
}

/** The listed dimensions; every dimension when none is listed. */
export function dimensions(...ids: string[]): Acceptor<Dimension> {
  return acceptor(['dimension'], listed(ids));
}

/** The escape hatch: any rule over type ids, for the target type the caller names. */
export function accepting<T extends StorableTarget>(test: (typeId: string, kind: TargetKind) => boolean, kinds?: readonly TargetKind[]): Acceptor<T> {
  return acceptor(kinds ?? ALL_KINDS, test);
}

// ─── Composition ───────────────────────────────────────────────────────────────

type Of<R extends Rule> = R extends Acceptor<infer T> ? T : never;

type Union<A extends readonly Rule[]> = Of<A[number]>;

type Intersection<A extends readonly Rule[]>
  = A extends readonly [infer H extends Rule, ...infer R extends readonly Rule[]] ? Of<H> & Intersection<R> : unknown;

/** Any of the rules: `anyOf(players(), entityTypes('papi:merchant'))` takes a `Player | Entity`. */
export function anyOf<const A extends readonly Rule[]>(...acceptors: A): Acceptor<Union<A>> {
  const kinds = [...new Set(acceptors.flatMap(a => a.kinds))];

  return acceptor(kinds, (typeId, kind) => acceptors.some(a => accepts(a, typeId, kind)));
}

/** All of the rules: the target type is the intersection. */
export function allOf<const A extends readonly Rule[]>(...acceptors: A): Acceptor<Intersection<A>> {
  const kinds = acceptors.length === 0
    ? ALL_KINDS
    : acceptors.map(a => a.kinds).reduce((shared, next) => shared.filter(kind => next.includes(kind)));

  return acceptor(kinds, (typeId, kind) => acceptors.every(a => accepts(a, typeId, kind)));
}

/**
 * The base rule minus another: `except(entityTypes(), players())` takes every entity but a player.
 * The type stays the base type — TypeScript cannot subtract a subclass — so what is excluded is
 * refused when `for()` runs, with a reason.
 */
export function except<T>(base: Acceptor<T>, excluded: Rule): Acceptor<T> {
  return acceptor(base.kinds, (typeId, kind) => accepts(base, typeId, kind) && !accepts(excluded, typeId, kind));
}

// ─── The static check ──────────────────────────────────────────────────────────

/** What a collection may demand of its host. Only `true` is a demand; omitted means indifferent. */
export interface Requirements {
  /** The bytes live on the target and die with it — no orphans, no cleanup. */
  readonly own?: true;
  /** Keys can be listed. */
  readonly enumerable?: true;
  /** Documents stay reachable while the target is unloaded. */
  readonly readableWhenUnloaded?: true;
}

/**
 * What each target type can possibly do. `true` always, `false` never, `boolean` only the instance
 * knows — a block is `own` when its type declares a block entity, a slot when its item does not
 * stack — and only the resolver can answer that, at runtime.
 */
export type Caps<T>
  = T extends ItemStack ? never
    : T extends Dimension ? { own: false; enumerable: true; readableWhenUnloaded: true }
      : T extends Block ? { own: boolean; enumerable: boolean; readableWhenUnloaded: boolean }
        : T extends World ? { own: true; enumerable: true; readableWhenUnloaded: true }
          : T extends ContainerSlot ? { own: boolean; enumerable: true; readableWhenUnloaded: false }
            : T extends Entity ? { own: true; enumerable: true; readableWhenUnloaded: false }
              : { own: boolean; enumerable: boolean; readableWhenUnloaded: boolean };

type Impossible<T, R> = {
  [K in keyof R & keyof Caps<T>]: R[K] extends true
    ? (Caps<T>[K] extends false ? `require.${K & string} is impossible: this target type never has it` : never)
    : never;
}[keyof R & keyof Caps<T>];

type Exclusive<R> = R extends { own: true; readableWhenUnloaded: true }
  ? 'require.own and require.readableWhenUnloaded are mutually exclusive'
  : never;

type Problems<T, R> = ([Caps<T>] extends [never] ? 'accept: an ItemStack is a detached copy, use slots()' : never) | Impossible<T, R> | Exclusive<R>;

/**
 * `unknown` when `require` is satisfiable for the target type — intersecting with it changes
 * nothing — and otherwise an object demanding a property named after the conflict, so the reason
 * is the missing-property message in the IDE.
 */
export type Conflicts<T, R> = [Problems<T, R>] extends [never] ? unknown : Record<Problems<T, R>, never>;
