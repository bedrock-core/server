/**
 * The chunked index on its own, and `all()` walking it through a stub locator: entries appear on
 * the first write and vanish on delete, chunks split under the per-value cap, a replaced block heals
 * out of the index with its world-kept document, and `blockRemoved` does the same from `onBreak`.
 */
import { describe, expect, it } from 'vitest';
import { blockTypes, createDb, createIndexSet, directHost, prefixed, schema } from '../src/index';
import type { Collection, Locator, Schema, TargetKind } from '../src/index';
import { BlockStub, ComponentStub, DimensionStub, EntityStub, WorldStub } from './stubs';

describe('index set', () => {
  it('adds, removes and reloads from the world', () => {
    const world = new WorldStub();
    const host = prefixed(directHost(world), 'core-db:ns:index:things:');
    const index = createIndexSet(host);

    expect(index.size).toBe(0);
    index.add('entity:1');
    index.add('entity:2');
    index.add('entity:1');

    expect(index.size).toBe(2);
    expect(index.has('entity:2')).toBe(true);
    expect(world.getDynamicProperty('core-db:ns:index:things:0')).toBe('entity:1\nentity:2');

    index.remove('entity:1');
    expect(world.getDynamicProperty('core-db:ns:index:things:0')).toBe('entity:2');

    const reloaded = createIndexSet(host);

    expect([...reloaded.entries()]).toEqual(['entity:2']);
  });

  it('opens a new chunk when the next entry would not fit', () => {
    const world = new WorldStub();
    const index = createIndexSet(prefixed(directHost(world), 'i:'), { budget: 30 });

    index.add('a'.repeat(12));
    index.add('b'.repeat(12));
    index.add('c'.repeat(12));

    expect(world.getDynamicProperty('i:0')).toBe(`${'a'.repeat(12)}\n${'b'.repeat(12)}`);
    expect(world.getDynamicProperty('i:1')).toBe('c'.repeat(12));
    expect(index.size).toBe(3);

    index.remove('b'.repeat(12));
    expect(world.getDynamicProperty('i:0')).toBe('a'.repeat(12));
    expect([...createIndexSet(prefixed(directHost(world), 'i:'), { budget: 30 }).entries()].sort()).toEqual(['a'.repeat(12), 'c'.repeat(12)]);
  });
});

// ─── all() through a stub world ────────────────────────────────────────────────

interface Elevator {
  facing: string;
}

interface LooseDb {
  collection<T extends object>(name: string, options: { schema: Schema<T>; accept?: { kinds: readonly TargetKind[]; test(typeId: string, kind: TargetKind): boolean } }): Collection<T, unknown>;
  blockRemoved(dimensionId: string, location: { x: number; y: number; z: number }, typeId: string): void;
}

/** A tiny world: entities by id, blocks by position, dimensions by id. */
function stubWorld(): { world: WorldStub; entities: Map<string, EntityStub>; blocks: Map<string, BlockStub>; dimensions: Map<string, DimensionStub>; db: LooseDb } {
  const world = new WorldStub();
  const entities = new Map<string, EntityStub>();
  const blocks = new Map<string, BlockStub>();
  const dimensions = new Map<string, DimensionStub>();
  const locate: Locator = {
    bind: target => (): unknown => {
      if (target instanceof EntityStub) {
        return entities.get(target.id);
      }

      if (target instanceof BlockStub) {
        return blocks.get(`${target.dimension.id}:${target.location.x},${target.location.y},${target.location.z}`);
      }

      return target;
    },
    fromIdentity: (kind, identity): unknown => {
      if (kind === 'entity') {
        return entities.get(identity);
      }

      if (kind === 'dimension') {
        return dimensions.get(identity);
      }

      if (kind === 'block') {
        const match = /^(.*):(-?\d+),(-?\d+),(-?\d+):(.*)$/.exec(identity);

        return match === null ? undefined : blocks.get(`${match[1]}:${match[2]},${match[3]},${match[4]}`);
      }

      return undefined;
    },
  };

  return { world, entities, blocks, dimensions, db: createDb({ world, namespace: 'ns', locate }) };
}

function placeBlock(blocks: Map<string, BlockStub>, typeId: string, x: number, y: number, z: number, component: ComponentStub | undefined): BlockStub {
  const block = new BlockStub(typeId, { x, y, z }, { id: 'overworld' }, component);

  blocks.set(`overworld:${x},${y},${z}`, block);

  return block;
}

describe('all()', () => {
  it('yields every indexed document and forgets deleted ones', () => {
    const { entities, db } = stubWorld();
    const balances = db.collection('balances', { schema: schema<{ gold: number }>() });
    const a = new EntityStub('a', 'minecraft:player');
    const b = new EntityStub('b', 'minecraft:player');

    entities.set('a', a);
    entities.set('b', b);
    balances.for(a).set({ gold: 1 });
    balances.for(b).set({ gold: 2 });
    balances.for(b).patch({ gold: 3 });

    expect(balances.size).toBe(2);
    expect([...balances.all()].map(doc => [doc.identity, doc.get()?.gold])).toEqual([['a', 1], ['b', 3]]);

    balances.for(a).delete();
    expect([...balances.all()].map(doc => doc.identity)).toEqual(['b']);
  });

  it('yields an unreachable handle for an unloaded entity and keeps the entry', () => {
    const { entities, db } = stubWorld();
    const balances = db.collection('balances', { schema: schema<{ gold: number }>() });
    const a = new EntityStub('a', 'minecraft:player');

    entities.set('a', a);
    balances.for(a).set({ gold: 1 });
    entities.delete('a');

    const [doc] = [...balances.all()];

    expect(doc?.identity).toBe('a');
    expect(doc?.available).toBe(false);
    expect(doc?.get()).toBeUndefined();
    expect(balances.size).toBe(1);
  });

  it('reads a proxied document through the index while its target is unloaded', () => {
    const { dimensions, db } = stubWorld();
    const regions = db.collection('regions', { schema: schema<{ name: string }>() });
    const nether = new DimensionStub('minecraft:nether');

    dimensions.set('minecraft:nether', nether);
    regions.for(nether).set({ name: 'hell' });
    dimensions.clear();

    const [doc] = [...regions.all()];

    expect(doc?.available).toBe(true);
    expect(doc?.get()).toEqual({ name: 'hell' });
  });

  it('drops a block replaced by another type, and its world-kept document', () => {
    const { world, blocks, db } = stubWorld();
    const signs = db.collection('signs', { schema: schema<Elevator>(), accept: blockTypes('minecraft:oak_sign', 'minecraft:stone') });
    const sign = placeBlock(blocks, 'minecraft:oak_sign', 1, 2, 3, undefined);

    signs.for(sign).set({ facing: 'north' });
    expect(world.getDynamicProperty('core-db:ns:block:overworld:1,2,3:minecraft:oak_sign:signs:doc')).toBeDefined();

    placeBlock(blocks, 'minecraft:stone', 1, 2, 3, undefined);

    expect([...signs.all()]).toEqual([]);
    expect(signs.size).toBe(0);
    expect(world.getDynamicProperty('core-db:ns:block:overworld:1,2,3:minecraft:oak_sign:signs:doc')).toBeUndefined();
  });

  it('keeps a block entity document reachable through the index and heals on blockRemoved', () => {
    const { world, blocks, db } = stubWorld();
    const elevators = db.collection('elevators', { schema: schema<Elevator>(), accept: blockTypes('papi:elevator') });
    const others = db.collection('others', { schema: schema<Elevator>(), accept: blockTypes('papi:elevator') });
    const lift = placeBlock(blocks, 'papi:elevator', 5, 6, 7, new ComponentStub());

    elevators.for(lift).set({ facing: 'east' });
    others.for(lift).set({ facing: 'west' });

    const [doc] = [...elevators.all()];

    expect(doc?.kind).toBe('block');
    expect(doc?.get()).toEqual({ facing: 'east' });

    blocks.delete('overworld:5,6,7');
    db.blockRemoved('overworld', { x: 5, y: 6, z: 7 }, 'papi:elevator');

    expect(elevators.size).toBe(0);
    expect(others.size).toBe(0);
    expect([...elevators.all()]).toEqual([]);
    expect(world.getDynamicPropertyIds().filter(id => !id.includes(':index:'))).toEqual([]);
  });

  it('never indexes the world or a slot', () => {
    const { world, db } = stubWorld();
    const settings = db.collection('settings', { schema: schema<{ on: boolean }>() });

    settings.for(world).set({ on: true });

    expect(settings.size).toBe(0);
    expect([...settings.all()]).toEqual([]);
    expect(world.getDynamicPropertyIds()).toEqual(['core-db:ns:world::settings:doc']);
  });
});
