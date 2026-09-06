/**
 * The engine half — the only file in this package that imports `@minecraft/server`.
 *
 * `engineClassifier` recognizes targets by class, which is exact where the structural test reads
 * members; `engineLocator` finds a kept target again through the world — an entity by id, a block
 * by dimension and location — so a stale handle is never dereferenced; `createEngineResolver` and
 * `createEngineDb` bind both to the real world.
 */
import { Block, ContainerSlot, Dimension, Entity, ItemStack, World, world } from '@minecraft/server';
import { createDb, type Db, type Locator } from './collection';
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
};

export function createEngineResolver(namespace: string): Resolver {
  return createResolver({ world, namespace, classify: engineClassifier });
}

export function createEngineDb(namespace: string, log?: (message: string) => void): Db {
  return createDb({ resolver: createEngineResolver(namespace), locate: engineLocator, log });
}
