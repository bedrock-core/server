import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => {
  class Entity {
    isValid = true;
    readonly components = new Map<string, EntityComponent>();
    constructor(readonly id: string) {}
    getComponent(id: string): EntityComponent | undefined { return this.components.get(id); }
  }
  class Player extends Entity {}
  class LocationInUnloadedChunkError extends Error {}
  class Dimension {
    readonly blocks = new Map<string, Block>();
    unloaded = false;
    constructor(readonly id: string) {}
    getBlock(location: { x: number; y: number; z: number }): Block | undefined {
      if (this.unloaded) { throw new LocationInUnloadedChunkError(); }

      return this.blocks.get(JSON.stringify(location));
    }
  }
  class Block {
    readonly components = new Map<string, BlockComponent>();
    constructor(readonly dimension: Dimension, readonly location: { x: number; y: number; z: number }, readonly typeId: string) {}
    getComponent(id: string): BlockComponent | undefined { return this.components.get(id); }
  }
  class ContainerSlot {
    constructor(readonly container: Container, readonly index: number) {}
    get value(): string | undefined { return this.container.items[this.index]; }
    set value(value: string | undefined) { this.container.items[this.index] = value; }
  }
  class Container {
    readonly items: (string | undefined)[] = [];
    getSlot(index: number): ContainerSlot { return new ContainerSlot(this, index); }
  }
  class EntityComponent {
    constructor(readonly entity: Entity, readonly typeId: string) {}
  }
  class EntityInventoryComponent extends EntityComponent { readonly container = new Container(); }
  class BlockComponent {
    constructor(readonly block: Block, readonly typeId: string) {}
  }
  class BlockInventoryComponent extends BlockComponent { readonly container = new Container(); }

  return { Entity, Player, Block, Dimension, EntityComponent, EntityInventoryComponent, BlockComponent, BlockInventoryComponent,
    Container, ContainerSlot, LocationInUnloadedChunkError, entities: new Map<string, Entity>(), dimensions: new Map<string, Dimension>() };
});

vi.mock('@minecraft/server', () => ({
  ...engine,
  world: {
    getEntity: (id: string): InstanceType<typeof engine.Entity> | undefined => engine.entities.get(id),
    getDimension: (id: string): InstanceType<typeof engine.Dimension> => {
      const dimension = engine.dimensions.get(id);

      if (!dimension) { throw new Error('unknown dimension'); }

      return dimension;
    },
  },
}));

const { nativeReferences } = await import('../src/api/references');
const { nativeAccess } = await import('../src/api/native-access');

beforeEach(() => { engine.entities.clear(); engine.dimensions.clear(); });

describe('native reference adapters', () => {
  it('resolves serialized block locations against current dimension contents', () => {
    const dimension = new engine.Dimension('overworld');
    const location = { x: 3, y: 64, z: -1 };
    const original = new engine.Block(dimension, location, 'stone');

    engine.dimensions.set(dimension.id, dimension);
    dimension.blocks.set(JSON.stringify(location), original);
    const wire: unknown = JSON.parse(JSON.stringify(nativeReferences.encode(original, 'block')));

    expect(nativeReferences.decode(wire, 'block')).toBe(original);
    const replaced = new engine.Block(dimension, location, 'gold');

    dimension.blocks.set(JSON.stringify(location), replaced);
    expect(nativeReferences.decode(wire, 'block')).toBe(replaced);
    dimension.unloaded = true;
    expect(nativeReferences.decode(wire, 'block')).toBeUndefined();
    expect(nativeReferences.decode(nativeReferences.encode(dimension, 'dimension'), 'dimension')).toBe(dimension);
  });

  it('rejects malformed locators and preserves player type validation', () => {
    const entity = new engine.Entity('entity');

    engine.entities.set(entity.id, entity);
    expect(() => nativeReferences.decode('', 'entity')).toThrow('identifier');
    expect(() => nativeReferences.decode({ dimension: 'overworld', x: 1.5, y: 64, z: 0 }, 'block')).toThrow('block reference');
    expect(() => nativeReferences.decode(entity.id, 'player')).toThrow('not a player');
    expect(() => nativeReferences.encode(entity, 'player')).toThrow('Minecraft player');
    entity.isValid = false;
    expect(nativeReferences.decode(entity.id, 'entity')).toBeUndefined();
  });

  it('transfers components by their native owners and validates declared component classes', () => {
    const entity = new engine.Entity('inventory');
    const component = new engine.EntityInventoryComponent(entity, 'minecraft:inventory');

    entity.components.set(component.typeId, component);
    engine.entities.set(entity.id, entity);
    const wire: unknown = JSON.parse(JSON.stringify(nativeReferences.encode(component, 'entity-component', 'EntityInventoryComponent')));

    expect(nativeReferences.decode(wire, 'entity-component', 'EntityInventoryComponent')).toBe(component);
    expect(() => nativeReferences.decode(wire, 'entity-component', 'BlockInventoryComponent')).toThrow('BlockInventoryComponent');
    expect(() => nativeReferences.encode(component, 'block-component')).toThrow('block-component');
    entity.isValid = false;
    expect(nativeReferences.decode(wire, 'entity-component')).toBeUndefined();
  });

  it('captures local slots, forwards decoded handles and shares the current native inventory', () => {
    const entity = new engine.Entity('inventory');
    const component = new engine.EntityInventoryComponent(entity, 'minecraft:inventory');

    entity.components.set(component.typeId, component);
    engine.entities.set(entity.id, entity);
    expect(() => nativeReferences.encode(component.container.getSlot(2), 'container-slot')).toThrow('captured lookup');
    const original = nativeAccess.inventorySlot(entity, 2, 'Entity.getComponent', false);
    const wire: unknown = JSON.parse(JSON.stringify(nativeReferences.encode(original, 'container-slot')));
    const received = nativeReferences.decode(wire, 'container-slot', 'ContainerSlot');

    if (!(received instanceof engine.ContainerSlot)) { throw new Error('expected native slot'); }

    received.value = 'diamond';
    expect(component.container.getSlot(2).value).toBe('diamond');
    const forwarded = nativeReferences.decode(JSON.parse(JSON.stringify(nativeReferences.encode(received, 'container-slot'))), 'container-slot');

    expect(forwarded).toBeInstanceOf(engine.ContainerSlot);
    entity.isValid = false;
    expect(nativeReferences.decode(wire, 'container-slot')).toBeUndefined();
  });

  it('resolves block inventories after replacement and rejects forged paths before native lookup', () => {
    const dimension = new engine.Dimension('overworld');
    const location = { x: 3, y: 64, z: -1 };
    const block = new engine.Block(dimension, location, 'chest');
    const component = new engine.BlockInventoryComponent(block, 'minecraft:inventory');

    block.components.set(component.typeId, component);
    engine.dimensions.set(dimension.id, dimension);
    dimension.blocks.set(JSON.stringify(location), block);
    nativeAccess.call1(block, 'getComponent', 'minecraft:inventory', 'Block.getComponent', 'native');
    const container = nativeAccess.get(component, 'container', 'BlockInventoryComponent.container', 'native');
    const wire: unknown = JSON.parse(JSON.stringify(nativeReferences.encode(container, 'container')));
    const replacement = new engine.Block(dimension, location, 'chest');
    const replacementInventory = new engine.BlockInventoryComponent(replacement, 'minecraft:inventory');

    replacement.components.set(replacementInventory.typeId, replacementInventory);
    dimension.blocks.set(JSON.stringify(location), replacement);
    expect(nativeReferences.decode(wire, 'container')).toBe(replacementInventory.container);
    expect(() => nativeReferences.decode({ version: 1, root: { kind: 'entity', id: 'inventory' },
      path: [{ operation: 'Entity.getComponent', args: ['minecraft:health'] }, { operation: 'EntityInventoryComponent.container', args: [] }] }, 'container')).toThrow('lookup path');
    expect(() => nativeReferences.decode(wire, 'container-slot')).toThrow('lookup path');
  });
});
