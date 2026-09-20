/**
 * Collections over the resolver: typed handles, accept and require refusals with reasons, the
 * validity gate on every operation, proxied documents readable while the target is unloaded,
 * caching and local change events, and two collections on one target staying apart.
 */
import { describe, expect, it, vi } from 'vitest';
import { DbTargetError, accepting, accepts, allOf, anyOf, blockTypes, createDb, dimensions, entityTypes, except, players, schema, slots, worldTarget } from '../src/index';
import type { Collection, Requirements, Rule, Schema } from '../src/index';
import { BlockStub, ComponentStub, DimensionStub, EntityStub, ItemStackStub, SlotStub, WorldStub } from './stubs';

interface Balance {
  gold: number;
  lastSeen: number;
}

interface Elevator {
  configured: boolean;
  facing: string;
}

interface Settings {
  economy: { taxRate: number; currency: string };
  tags: string[];
}

/** The stubs are not engine classes, so the typed `for()` is widened for these tests. */
interface LooseDb {
  collection<T extends object>(
    name: string,
    options: { schema: Schema<T>; accept?: Rule; require?: Requirements },
  ): Collection<T, unknown>;
}

function db(world = new WorldStub()): { world: WorldStub; db: LooseDb; log: ReturnType<typeof vi.fn<(message: string) => void>> } {
  const log = vi.fn<(message: string) => void>();

  return { world, db: createDb({ world, namespace: 'ns', log }), log };
}

describe('documents on own hosts', () => {
  it('reads undefined, then the written document, then a patched one', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const player = new EntityStub('p1', 'minecraft:player');
    const doc = balances.for(player);

    expect(doc.available).toBe(true);
    expect(doc.get()).toBeUndefined();

    doc.set({ gold: 10, lastSeen: 1 });
    expect(doc.get()).toEqual({ gold: 10, lastSeen: 1 });

    doc.patch({ gold: 11 });
    expect(doc.get()).toEqual({ gold: 11, lastSeen: 1 });
    expect(player.getDynamicPropertyIds()).toEqual(['core-db:ns:entity::balances:doc']);
  });

  it('patches over defaults when there is no document yet, and stores only what was written', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>({ defaults: { gold: 0, lastSeen: 0 } }) });
    const player = new EntityStub('p1', 'minecraft:player');
    const doc = balances.for(player);

    doc.patch({ gold: 5 });
    expect(doc.get()).toEqual({ gold: 5, lastSeen: 0 });
    expect(player.getDynamicProperty('core-db:ns:entity::balances:doc')).toBe('{"v":1,"d":{"gold":5}}');
  });

  it('fills defaults at every depth without persisting them', () => {
    const { db: store } = db();
    const settings = store.collection('settings', {
      schema: schema<Settings>({ defaults: { economy: { taxRate: 0.05, currency: 'emerald' }, tags: [] } }),
    });
    const player = new EntityStub('p1', 'minecraft:player');
    const doc = settings.for(player);

    doc.patch({ economy: { taxRate: 0.2 } });

    expect(doc.get()).toEqual({ economy: { taxRate: 0.2, currency: 'emerald' }, tags: [] });
    expect(player.getDynamicProperty('core-db:ns:entity::settings:doc')).toBe('{"v":1,"d":{"economy":{"taxRate":0.2}}}');
  });

  it('patches deep: nested objects merge, arrays replace, undefined deletes', () => {
    const { db: store } = db();
    const settings = store.collection('settings', { schema: schema<Settings>({ defaults: { economy: { taxRate: 0.05, currency: 'emerald' }, tags: [] } }) });
    const player = new EntityStub('p1', 'minecraft:player');
    const doc = settings.for(player);
    const seen: (Settings | undefined)[] = [];

    doc.subscribe((next) => { seen.push(next); });
    doc.set({ economy: { taxRate: 0.2, currency: 'gold' }, tags: ['a', 'b'] });
    doc.patch({ economy: { taxRate: 0.3 }, tags: ['c'] });

    expect(doc.get()).toEqual({ economy: { taxRate: 0.3, currency: 'gold' }, tags: ['c'] });

    // Deleting a key puts it back to its default, and the bytes no longer carry it.
    doc.patch({ economy: { currency: undefined } });

    expect(doc.get()).toEqual({ economy: { taxRate: 0.3, currency: 'emerald' }, tags: ['c'] });
    expect(player.getDynamicProperty('core-db:ns:entity::settings:doc')).toBe('{"v":1,"d":{"economy":{"taxRate":0.3},"tags":["c"]}}');
    // Subscribers see the document as `get` gives it, defaults filled.
    expect(seen.at(-1)).toEqual({ economy: { taxRate: 0.3, currency: 'emerald' }, tags: ['c'] });
  });

  it('tells a subscriber attached before the first read when the document loads', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const player = new EntityStub('p1', 'minecraft:player');

    balances.for(player).set({ gold: 3, lastSeen: 0 });
    balances.forget(player);

    const seen: (Balance | undefined)[] = [];

    balances.for(player).subscribe((next) => { seen.push(next); });
    expect(seen).toEqual([]);

    expect(balances.for(player).get()).toEqual({ gold: 3, lastSeen: 0 });
    expect(seen).toEqual([{ gold: 3, lastSeen: 0 }]);

    // Later reads are cached and say nothing.
    balances.for(player).get();
    expect(seen).toHaveLength(1);
  });

  it('runs normalize over every write, before defaults', () => {
    const { db: store } = db();
    const normalize = vi.fn((doc: Balance): Balance => ({ ...doc, gold: Math.min(doc.gold, 100) }));
    const balances = store.collection('balances', { schema: schema<Balance>({ defaults: { gold: 0, lastSeen: 0 }, normalize }) });
    const player = new EntityStub('p1', 'minecraft:player');
    const doc = balances.for(player);

    doc.set({ gold: 500, lastSeen: 1 });
    expect(doc.get()).toEqual({ gold: 100, lastSeen: 1 });

    doc.patch({ gold: 900 });
    expect(doc.get()).toEqual({ gold: 100, lastSeen: 1 });
    expect(player.getDynamicProperty('core-db:ns:entity::balances:doc')).toBe('{"v":1,"d":{"gold":100,"lastSeen":1}}');
    // Once per write, over the document as it will be stored.
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(normalize.mock.calls[1]?.[0]).toEqual({ gold: 900, lastSeen: 1 });
  });

  it('keeps two collections and two targets apart', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const homes = store.collection('homes', { schema: schema<{ x: number }>() });
    const a = new EntityStub('a', 'minecraft:player');
    const b = new EntityStub('b', 'minecraft:player');

    balances.for(a).set({ gold: 1, lastSeen: 0 });
    balances.for(b).set({ gold: 2, lastSeen: 0 });
    homes.for(a).set({ x: 9 });

    expect(balances.for(a).get()).toEqual({ gold: 1, lastSeen: 0 });
    expect(balances.for(b).get()).toEqual({ gold: 2, lastSeen: 0 });
    expect(homes.for(a).get()).toEqual({ x: 9 });
    expect(homes.for(b).get()).toBeUndefined();
  });

  it('stores a block entity document on the block itself under the short prefix', () => {
    const { db: store, world } = db();
    const component = new ComponentStub();
    const block = new BlockStub('papi:elevator', { x: 1, y: 2, z: 3 }, { id: 'overworld' }, component);
    const elevators = store.collection('elevators', { schema: schema<Elevator>(), require: { own: true } });

    elevators.for(block).set({ configured: true, facing: 'north' });

    expect(component.get('elevators:doc')).toBe('{"v":1,"d":{"configured":true,"facing":"north"}}');
    // Only the index touches the world: the document is on the block.
    expect(world.getDynamicPropertyIds()).toEqual(['core-db:ns:index:elevators:0']);
    expect(world.getDynamicProperty('core-db:ns:index:elevators:0')).toBe('block:overworld:1,2,3:papi:elevator');
    expect(elevators.where(block)).toMatchObject({ ok: true, kind: 'block', caps: { own: true, enumerable: false } });
  });

  it('deletes and reports through where()', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const player = new EntityStub('p1', 'minecraft:player');

    balances.for(player).set({ gold: 1, lastSeen: 0 });
    balances.for(player).delete();

    expect(balances.for(player).get()).toBeUndefined();
    expect(player.getDynamicPropertyIds()).toEqual([]);
    expect(balances.where(player)).toMatchObject({ ok: true, kind: 'entity', caps: { own: true } });
  });
});

describe('accept and require', () => {
  it('refuses a target the acceptor does not list, with a reason naming the collection', () => {
    const { db: store } = db();
    const elevators = store.collection('elevators', { schema: schema<Elevator>(), accept: blockTypes('papi:elevator') });
    const stone = new BlockStub('minecraft:stone', { x: 0, y: 0, z: 0 }, { id: 'overworld' }, undefined);
    const lift = new BlockStub('papi:elevator', { x: 0, y: 0, z: 0 }, { id: 'overworld' }, new ComponentStub());
    const player = new EntityStub('p1', 'minecraft:player');

    expect(elevators.where(stone)).toMatchObject({ ok: false, reason: expect.stringContaining('elevators') });
    expect(elevators.where(player)).toMatchObject({ ok: false, kind: 'entity' });
    expect(elevators.where(lift)).toMatchObject({ ok: true });

    const refused = elevators.for(stone);

    expect(refused.available).toBe(false);
    expect(refused.reason).toContain('minecraft:stone');
    expect(() => refused.set({ configured: true, facing: 'north' })).toThrow(DbTargetError);
  });

  it('asks the acceptor once per type', () => {
    const { db: store } = db();
    const test = vi.fn((typeId: string) => typeId.startsWith('ns:'));
    const mobs = store.collection('mobs', { schema: schema<Balance>(), accept: accepting(test, ['entity']) });

    expect(mobs.where(new EntityStub('1', 'ns:mob')).ok).toBe(true);
    expect(mobs.where(new EntityStub('2', 'ns:mob')).ok).toBe(true);
    expect(mobs.where(new EntityStub('3', 'minecraft:cow')).ok).toBe(false);
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('refuses require.own on a proxied host instead of storing on the world', () => {
    const { db: store, world } = db();
    const strict = store.collection('strict', { schema: schema<Elevator>(), require: { own: true } });
    const stone = new BlockStub('minecraft:stone', { x: 0, y: 0, z: 0 }, { id: 'overworld' }, undefined);

    expect(strict.where(stone)).toMatchObject({ ok: false, reason: expect.stringContaining('require.own') });
    expect(() => strict.for(stone).set({ configured: false, facing: 'n' })).toThrow(/require.own/);
    expect(world.getDynamicPropertyIds()).toEqual([]);
  });

  it('refuses require.enumerable on a block entity and require.readableWhenUnloaded on an entity', () => {
    const { db: store } = db();
    const listed = store.collection('listed', { schema: schema<Elevator>(), require: { enumerable: true } });
    const offline = store.collection('offline', { schema: schema<Balance>(), require: { readableWhenUnloaded: true } });
    const lift = new BlockStub('papi:elevator', { x: 0, y: 0, z: 0 }, { id: 'overworld' }, new ComponentStub());

    expect(listed.where(lift)).toMatchObject({ ok: false, reason: expect.stringContaining('require.enumerable') });
    expect(offline.where(new EntityStub('p', 'minecraft:player'))).toMatchObject({ ok: false, reason: expect.stringContaining('readableWhenUnloaded') });
  });

  it('composes acceptors: anyOf unions kinds, allOf intersects them, except subtracts a rule', () => {
    const merchantsOrPlayers = anyOf(players(), entityTypes('papi:merchant'), blockTypes('papi:stall'));

    expect([...merchantsOrPlayers.kinds].sort()).toEqual(['block', 'entity']);
    expect(accepts(merchantsOrPlayers, 'minecraft:player', 'entity')).toBe(true);
    expect(accepts(merchantsOrPlayers, 'papi:merchant', 'entity')).toBe(true);
    expect(accepts(merchantsOrPlayers, 'papi:stall', 'block')).toBe(true);
    expect(accepts(merchantsOrPlayers, 'papi:stall', 'entity')).toBe(false);
    expect(accepts(merchantsOrPlayers, 'minecraft:cow', 'entity')).toBe(false);

    const namespaced = allOf(entityTypes(), accepting(id => id.startsWith('papi:')));

    expect(namespaced.kinds).toEqual(['entity']);
    expect(accepts(namespaced, 'papi:merchant', 'entity')).toBe(true);
    expect(accepts(namespaced, 'minecraft:cow', 'entity')).toBe(false);
    expect(accepts(namespaced, 'papi:stall', 'block')).toBe(false);

    const mobs = except(entityTypes(), players());

    expect(accepts(mobs, 'minecraft:cow', 'entity')).toBe(true);
    expect(accepts(mobs, 'minecraft:player', 'entity')).toBe(false);

    // Nested: (own mobs, except bosses) or own blocks.
    const nested = anyOf(except(allOf(entityTypes(), accepting(id => id.startsWith('papi:'))), entityTypes('papi:boss')), blockTypes('papi:stall'));

    expect(accepts(nested, 'papi:merchant', 'entity')).toBe(true);
    expect(accepts(nested, 'papi:boss', 'entity')).toBe(false);
    expect(accepts(nested, 'papi:stall', 'block')).toBe(true);
    expect(accepts(nested, 'minecraft:cow', 'entity')).toBe(false);
  });

  it('a composed acceptor refuses through the collection with a reason', () => {
    const { db: store } = db();
    const mobs = store.collection('mobs', { schema: schema<Balance>(), accept: except(entityTypes(), players()) });
    const player = new EntityStub('p1', 'minecraft:player');

    expect(mobs.where(new EntityStub('c1', 'minecraft:cow'))).toMatchObject({ ok: true });
    expect(mobs.where(player)).toMatchObject({ ok: false, reason: expect.stringContaining('minecraft:player') });
    expect(() => mobs.for(player).set({ gold: 1, lastSeen: 0 })).toThrow(DbTargetError);
  });

  it('built-in acceptors narrow by kind and type', () => {
    expect(blockTypes('a:b').kinds).toEqual(['block']);
    expect(accepts(blockTypes('a:b'), 'a:b', 'block')).toBe(true);
    expect(accepts(blockTypes('a:b'), 'a:c', 'block')).toBe(false);
    expect(accepts(blockTypes('a:b'), 'a:b', 'entity')).toBe(false);
    expect(accepts(blockTypes(), 'anything', 'block')).toBe(true);
    expect(accepts(entityTypes('ns:mob'), 'ns:mob', 'entity')).toBe(true);
    expect(accepts(players(), 'minecraft:player', 'entity')).toBe(true);
    expect(accepts(players(), 'minecraft:cow', 'entity')).toBe(false);
    expect(slots('ns:sword').kinds).toEqual(['slot']);
    expect(worldTarget().kinds).toEqual(['world']);
    expect(accepts(dimensions('minecraft:nether'), 'minecraft:nether', 'dimension')).toBe(true);
    expect(accepts(dimensions(), 'minecraft:the_end', 'dimension')).toBe(true);
  });
});

describe('validity', () => {
  it('reads undefined and throws on write once an entity is gone', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const mob = new EntityStub('m1', 'ns:mob');
    const doc = balances.for(mob);

    doc.set({ gold: 1, lastSeen: 0 });
    mob.isValid = false;

    expect(doc.available).toBe(false);
    expect(doc.reason).toContain('not loaded or no longer exists');
    expect(doc.get()).toBeUndefined();
    expect(() => doc.set({ gold: 2, lastSeen: 0 })).toThrow(DbTargetError);
    expect(() => doc.patch({ gold: 2 })).toThrow(/balances/);
    expect(() => doc.delete()).not.toThrow();
    expect(mob.getDynamicPropertyIds()).toEqual(['core-db:ns:entity::balances:doc']);
  });

  it('keeps a proxied document readable and writable while its target is unloaded', () => {
    const { db: store, world } = db();
    const regions = store.collection('regions', { schema: schema<{ name: string }>() });
    const nether = new DimensionStub('minecraft:nether');
    const handle = regions.for(nether);

    handle.set({ name: 'hell' });

    const gone: LooseDb = createDb({
      world,
      namespace: 'ns',
      locate: { bind: () => (): unknown => undefined, fromIdentity: () => undefined },
    });
    const unloaded = gone.collection('regions', { schema: schema<{ name: string }>() }).for(nether);

    expect(unloaded.available).toBe(true);
    expect(unloaded.get()).toEqual({ name: 'hell' });
    unloaded.set({ name: 'nether' });
    expect(world.getDynamicProperty('core-db:ns:dimension:minecraft:nether:regions:doc')).toContain('nether');
    unloaded.delete();
    expect(world.getDynamicPropertyIds()).toEqual(['core-db:ns:index:regions:0']);
    expect(world.getDynamicProperty('core-db:ns:index:regions:0')).toBe('');
    expect(unloaded.get()).toBeUndefined();
  });

  it('refuses a slot that emptied or now holds a stackable item', () => {
    const { db: store } = db();
    const gems = store.collection('gems', { schema: schema<{ level: number }>() });
    const slot = new SlotStub(new ItemStackStub('ns:sword', 1));
    const doc = gems.for(slot);

    doc.set({ level: 3 });
    expect(doc.get()).toEqual({ level: 3 });

    slot.isValid = false;
    expect(doc.available).toBe(false);
    expect(doc.get()).toBeUndefined();

    const empty = gems.for(new SlotStub(undefined));

    expect(empty.available).toBe(false);
    expect(empty.reason).toContain('empty');
    expect(() => empty.set({ level: 1 })).toThrow(DbTargetError);
  });

  it('never resolves an ItemStack', () => {
    const { db: store } = db();
    const gems = store.collection('gems', { schema: schema<{ level: number }>() });

    expect(gems.where(new ItemStackStub('ns:sword', 1))).toMatchObject({ ok: false, reason: expect.stringContaining('ContainerSlot') });
  });
});

describe('cache and change events', () => {
  it('reads the property once per identity and serves the cached document after', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const player = new EntityStub('p1', 'minecraft:player');

    balances.for(player).set({ gold: 1, lastSeen: 0 });

    const spy = vi.spyOn(player, 'getDynamicProperty');

    balances.for(player).get();
    balances.for(player).get();

    expect(spy).not.toHaveBeenCalled();

    balances.forget(player);
    balances.for(player).get();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on set, patch and delete through any handle of the same target', () => {
    const { db: store } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const player = new EntityStub('p1', 'minecraft:player');
    const seen: (Balance | undefined)[] = [];
    const stop = balances.for(player).subscribe(doc => seen.push(doc));

    balances.for(player).set({ gold: 1, lastSeen: 0 });
    balances.for(player).patch({ gold: 2 });
    balances.for(player).delete();

    expect(seen).toEqual([{ gold: 1, lastSeen: 0 }, { gold: 2, lastSeen: 0 }, undefined]);

    stop();
    balances.for(player).set({ gold: 3, lastSeen: 0 });
    expect(seen).toHaveLength(3);
  });

  it('gives a refused handle a subscribe that never fires', () => {
    const { db: store } = db();
    const gems = store.collection('gems', { schema: schema<{ level: number }>() });
    const listener = vi.fn();
    const stop = gems.for(new SlotStub(undefined)).subscribe(listener);

    stop();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('quarantine surfaces through the collection', () => {
  it('returns undefined once and logs when the bytes are unreadable', () => {
    const { db: store, log } = db();
    const balances = store.collection('balances', { schema: schema<Balance>() });
    const player = new EntityStub('p1', 'minecraft:player');

    player.setDynamicProperty('core-db:ns:entity::balances:doc', '{broken');

    expect(balances.for(player).get()).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(player.getDynamicProperty('core-db:ns:entity::balances:doc#bad')).toBe('{broken');
  });
});
