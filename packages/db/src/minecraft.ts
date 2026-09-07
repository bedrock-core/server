/**
 * The engine half — the only file in this package that imports `@minecraft/server`.
 *
 * `engineClassifier` recognizes targets by class, which is exact where the structural test reads
 * members; `engineLocator` finds a kept target again through the world — an entity by id, a block
 * by dimension and location — so a stale handle is never dereferenced; `createEngineResolver` and
 * `createEngineDb` bind both to the real world.
 */
import { Block, ContainerSlot, Dimension, Entity, ItemStack, World, system, world, type BlockCustomComponent } from '@minecraft/server';
import { createDb, parseBlockIdentity, type Db, type Lifecycle, type Locator } from './collection';
import { createResolver, structuralClassifier, type Classifier, type Resolver, type TargetKind } from './resolve';

export const engineClassifier: Classifier = {
  kindOf(target: unknown): TargetKind {
    if (target instanceof World) {
      return 'world';
    }

    if (target instanceof ItemStack) {
      return 'itemStack';
    }

    if (target instanceof ContainerSlot) {
      return 'slot';
    }

    if (target instanceof Block) {
      return 'block';
    }

    if (target instanceof Entity) {
      return 'entity';
    }

    if (target instanceof Dimension) {
      return 'dimension';
    }

    return structuralClassifier.kindOf(target);
  },
};

export const engineLocator: Locator = {
  bind(target: unknown): () => unknown {
    if (target instanceof Entity) {
      const id = target.id;

      return (): unknown => world.getEntity(id);
    }

    if (target instanceof Block) {
      const { dimension, location } = target;

      return (): unknown => {
        try {
          return dimension.getBlock(location);
        } catch {
          return undefined;
        }
      };
    }

    if (target instanceof ContainerSlot) {
      return (): unknown => (target.isValid ? target : undefined);
    }

    return (): unknown => target;
  },

  fromIdentity(kind: TargetKind, identity: string): unknown {
    switch (kind) {
      case 'world':
        return world;

      case 'entity':
        return world.getEntity(identity);

      case 'dimension':
        try {
          return world.getDimension(identity);
        } catch {
          return undefined;
        }

      case 'block': {
        const parsed = parseBlockIdentity(identity);

        if (parsed === undefined) {
          return undefined;
        }

        try {
          return world.getDimension(parsed.dimensionId).getBlock(parsed);
        } catch {
          return undefined;
        }
      }

      default:
        return undefined;
    }
  },
};

export function createEngineResolver(namespace: string): Resolver {
  return createResolver({ world, namespace, classify: engineClassifier });
}

/**
 * What coalescing collections need from the engine: one flush per tick through `system.run`, an
 * entity's return through `entityLoad`, and a player's pending documents written in
 * `beforeEvents.playerLeave` — where a dynamic-property write is still allowed (measured). Nothing
 * here subscribes until the first coalescing collection asks.
 */
export const engineLifecycle: Lifecycle = {
  schedule(flush): void {
    system.run(flush);
  },

  tick: (): number => system.currentTick,

  attach({ loaded, leaving }): void {
    world.afterEvents.entityLoad.subscribe(({ entity }) => {
      loaded(entity);
    });
    world.beforeEvents.playerLeave.subscribe(({ player }) => {
      leaving(player);
    });
  },
};

export function createEngineDb(namespace: string, log?: (message: string) => void): Db {
  return createDb({ world, namespace, classify: engineClassifier, locate: engineLocator, lifecycle: engineLifecycle, log });
}

/**
 * The custom component that keeps block indexes honest. Register it once in `startup` and add it
 * to every block type a block collection accepts — a block type that references a component nobody
 * registered is removed from the world, so the registration is not optional:
 *
 * ```ts
 * system.beforeEvents.startup.subscribe(({ blockComponentRegistry }) => {
 *   blockComponentRegistry.registerCustomComponent('papi:db_block', blockCleanup(db));
 * });
 * ```
 *
 * `onBreak` fires for every removal — player, explosion, `/setblock` and `/fill` in either mode,
 * script `setPermutation` (measured) — with the block already air, so the identity comes from the
 * event's location and broken permutation, never from the block.
 */
export function blockCleanup(db: Db): BlockCustomComponent {
  return {
    onBreak({ block, brokenBlockPermutation, dimension }): void {
      db.blockRemoved(dimension.id, block.location, brokenBlockPermutation.type.id);
    },
  };
}
