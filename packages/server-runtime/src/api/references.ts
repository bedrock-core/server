import { Block, BlockComponent, Container, ContainerSlot, Dimension, Entity, EntityComponent, LocationInUnloadedChunkError, Player, world } from '@minecraft/server';
import * as minecraft from '@minecraft/server';
import type { NativeReference } from './types';
import { isRecord } from '../guards';
import { nativeAccess, NativeLookupUnavailableError } from './native-access';

function lookup(value: unknown, reference: NativeReference): unknown {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.root) || !Array.isArray(value.path)) {
    throw new TypeError('invalid API inventory lookup');
  }

  const entity = value.root.kind === 'entity';
  const block = value.root.kind === 'block';
  const component = reference === 'entity-component' || reference === 'block-component';
  const operations = [entity ? 'Entity.getComponent' : 'Block.getComponent',
    entity ? 'EntityInventoryComponent.container' : 'BlockInventoryComponent.container', 'Container.getSlot'];
  const count = component ? 1 : reference === 'container' ? 2 : 3;

  if ((!entity && !block) || (reference === 'entity-component' && !entity) || (reference === 'block-component' && !block)
    || value.path.length !== count || value.path.some((step: unknown, index: number) => !isRecord(step)
      || step.operation !== operations[index] || !Array.isArray(step.args)
      || (index === 0 && !component && step.args[0] !== 'minecraft:inventory'))) {
    throw new TypeError('invalid API inventory lookup path');
  }

  try { return nativeAccess.decode(value); } catch (error) {
    if (error instanceof NativeLookupUnavailableError || error instanceof LocationInUnloadedChunkError) { return undefined; }

    throw error;
  }
}

function componentAdapter(owner: 'entity' | 'block'): NativeAdapter {
  const reference = owner === 'entity' ? 'entity-component' : 'block-component';

  return {
    encode(value): unknown {
      if (!(value instanceof EntityComponent) && !(value instanceof BlockComponent)) {
        throw new TypeError(`expected a Minecraft ${reference} reference`);
      }

      if (owner === 'entity' ? !(value instanceof EntityComponent) : !(value instanceof BlockComponent)) {
        throw new TypeError(`expected a Minecraft ${reference} reference`);
      }

      try {
        const component = value;
        const root = component instanceof EntityComponent
          ? { kind: 'entity', id: component.entity.id }
          : { kind: 'block', dimension: component.block.dimension.id, ...component.block.location };

        return { version: 1, root, path: [{ operation: owner === 'entity' ? 'Entity.getComponent' : 'Block.getComponent', args: [component.typeId] }] };
      } catch (error) {
        try { return nativeAccess.encode(value); } catch { throw error; }
      }
    },
    decode(value): unknown { return lookup(value, reference); },
  };
}

interface NativeAdapter {
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) { throw new TypeError('invalid API reference identifier'); }

  return value;
}

/** Each adapter describes an engine-owned identity or location in the current world. */
const adapters: Record<NativeReference, NativeAdapter> = {
  'entity-component': componentAdapter('entity'),
  'block-component': componentAdapter('block'),
  'container': {
    encode(value) {
      if (!(value instanceof Container)) { throw new TypeError('expected a Minecraft container reference'); }

      return nativeAccess.encode(value);
    },
    decode(value) { return lookup(value, 'container'); },
  },
  'container-slot': {
    encode(value) {
      if (!(value instanceof ContainerSlot)) { throw new TypeError('expected a Minecraft container slot reference'); }

      return nativeAccess.encode(value);
    },
    decode(value) { return lookup(value, 'container-slot'); },
  },
  'entity': {
    encode(value) {
      if (!(value instanceof Entity)) { throw new TypeError('expected a Minecraft entity reference'); }

      return value.id;
    },
    decode(value) {
      const entity = world.getEntity(identifier(value));

      return entity?.isValid ? entity : undefined;
    },
  },
  'player': {
    encode(value) {
      if (!(value instanceof Player)) { throw new TypeError('expected a Minecraft player reference'); }

      return value.id;
    },
    decode(value) {
      const entity = adapters.entity.decode(value);

      if (entity !== undefined && !(entity instanceof Player)) { throw new TypeError('API entity is not a player'); }

      return entity;
    },
  },
  'dimension': {
    encode(value) {
      if (!(value instanceof Dimension)) { throw new TypeError('expected a Minecraft dimension reference'); }

      return value.id;
    },
    decode(value) { return world.getDimension(identifier(value)); },
  },
  'block': {
    encode(value) {
      if (!(value instanceof Block)) { throw new TypeError('expected a Minecraft block reference'); }

      return { dimension: value.dimension.id, ...value.location };
    },
    decode(value) {
      if (!isRecord(value) || ![value.x, value.y, value.z].every(item => typeof item === 'number' && Number.isSafeInteger(item))) {
        throw new TypeError('invalid API block reference');
      }

      const dimension = world.getDimension(identifier(value.dimension));
      const { x, y, z } = value;

      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') { throw new TypeError('invalid API block coordinates'); }

      try { return dimension.getBlock({ x, y, z }); } catch (error) {
        if (error instanceof LocationInUnloadedChunkError) { return undefined; }

        throw error;
      }
    },
  },
};

function checkType(value: unknown, nativeType: string | undefined): void {
  if (value === undefined || nativeType === undefined) { return; }

  const constructor: unknown = Reflect.get(minecraft, nativeType);

  if (typeof constructor !== 'function' || !(value instanceof constructor)) {
    throw new TypeError(`expected a Minecraft ${nativeType} reference`);
  }
}

export const nativeReferences = {
  encode(value: unknown, reference: NativeReference, nativeType?: string): unknown {
    checkType(value, nativeType);

    return adapters[reference].encode(value);
  },
  decode(value: unknown, reference: NativeReference, nativeType?: string): unknown {
    const result = adapters[reference].decode(value);

    checkType(result, nativeType);

    return result;
  },
};
