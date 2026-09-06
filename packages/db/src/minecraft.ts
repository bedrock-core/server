/**
 * The engine half — the only file in this package that imports `@minecraft/server`.
 *
 * `engineClassifier` recognizes targets by class, which is exact where the structural test reads
 * members; `createEngineResolver` binds the resolver to the real world.
 */
import { Block, ContainerSlot, Dimension, Entity, ItemStack, World, world } from '@minecraft/server';
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

export function createEngineResolver(namespace: string): Resolver {
  return createResolver({ world, namespace, classify: engineClassifier });
}
