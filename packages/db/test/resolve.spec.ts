/**
 * The resolver against stubs shaped like the engine's classes, with the behaviour the ABI survey
 * measured: a stackable item throws on write, a non-stackable stack writes to a copy, a block
 * entity answers through a three-method component, a dimension holds nothing, and `getComponent`
 * throws in an unloaded chunk.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMPONENT_BUDGET, DIRECT_BUDGET, createResolver, prefixed } from '../src/index';
import type { DirectDp, DpValue } from '../src/index';

// ─── Stubs ─────────────────────────────────────────────────────────────────────

class DirectStub implements DirectDp {
  private readonly _props = new Map<string, DpValue>();

  getDynamicProperty(id: string): DpValue | undefined {
    return this._props.get(id);
  }

  setDynamicProperty(id: string, value?: DpValue): void {
    if (value === undefined) {
      this._props.delete(id);
    } else {
      this._props.set(id, value);
    }
  }

  getDynamicPropertyIds(): string[] {
    return [...this._props.keys()];
  }

  getDynamicPropertyTotalByteCount(): number {
    return [...this._props.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  }

  setDynamicProperties(values: Record<string, DpValue | undefined>): void {
    for (const key of Object.keys(values)) {
      this.setDynamicProperty(key, values[key]);
    }
  }
}

class WorldStub extends DirectStub {
  getAllPlayers(): unknown[] {
    return [];
  }
}

class EntityStub extends DirectStub {
  constructor(readonly id: string, readonly typeId: string) {
    super();
  }
}

class ItemStackStub extends DirectStub {
  constructor(readonly typeId: string, readonly maxAmount: number) {
    super();
  }

  clone(): ItemStackStub {
    return new ItemStackStub(this.typeId, this.maxAmount);
  }
}

class SlotStub extends DirectStub {
  readonly maxAmount = 64;

  constructor(private readonly _item: ItemStackStub | undefined) {
    super();
  }

  getItem(): ItemStackStub | undefined {
    return this._item;
  }
}

class ComponentStub {
  private readonly _props = new Map<string, DpValue>();

  get(key: string): DpValue | undefined {
    return this._props.get(key);
  }

  set(key: string, value?: DpValue): void {
    if (value === undefined) {
      this._props.delete(key);
    } else {
      this._props.set(key, value);
    }
  }

  totalByteCount(): number {
    return [...this._props.entries()].reduce((n, [k, v]) => n + k.length + String(v).length, 0);
  }
}

class BlockStub {
  readonly permutation = {};
  readonly getComponent = vi.fn((id: string): unknown => (id === 'minecraft:dynamic_properties' ? this._component : undefined));

  constructor(
    readonly typeId: string,
    readonly location: { x: number; y: number; z: number },
    readonly dimension: { id: string },
    private readonly _component: ComponentStub | undefined,
  ) {}
}

class DimensionStub {
  constructor(readonly id: string) {}

  getBlock(): undefined {
    return undefined;
  }
}

function resolver(world = new WorldStub()): { world: WorldStub; resolve: ReturnType<typeof createResolver> } {
  return { world, resolve: createResolver({ world, namespace: 'ns' }) };
}

// ─── Refusals ──────────────────────────────────────────────────────────────────

describe('refusals', () => {
  it('refuses an ItemStack by name, whatever its stackability', () => {
    const { resolve } = resolver();
    const stackable = resolve.resolve(new ItemStackStub('minecraft:stone', 64));
    const single = resolve.resolve(new ItemStackStub('minecraft:diamond_sword', 1));

    expect(stackable).toMatchObject({ ok: false, kind: 'itemStack' });
    expect(single).toMatchObject({ ok: false, kind: 'itemStack' });
    expect(single.ok ? '' : single.reason).toContain('ContainerSlot');
  });

  it('refuses a slot holding a stackable item, and an empty slot', () => {
    const { resolve } = resolver();

    expect(resolve.resolve(new SlotStub(new ItemStackStub('minecraft:stone', 64)))).toMatchObject({ ok: false, kind: 'slot' });
    expect(resolve.resolve(new SlotStub(undefined))).toMatchObject({ ok: false, kind: 'slot' });
  });

  it('refuses what it does not recognize', () => {
    const { resolve } = resolver();

    expect(resolve.resolve(42)).toMatchObject({ ok: false, kind: 'unknown' });
    expect(resolve.resolve({ hello: 'world' })).toMatchObject({ ok: false, kind: 'unknown' });
  });
});

// ─── Own hosts ─────────────────────────────────────────────────────────────────

describe('own hosts', () => {
  it('resolves the world to a direct host that is readable when unloaded', () => {
    const { world, resolve } = resolver();
    const r = resolve.resolve(world);

    expect(r).toMatchObject({ ok: true, kind: 'world', identity: '' });

    if (!r.ok) { return; }

    expect(r.host.abi).toBe('direct');
    expect(r.host.caps).toMatchObject({ own: true, enumerable: true, readableWhenUnloaded: true, batch: true, budget: DIRECT_BUDGET });
    r.host.write('k', 'v');

    expect(world.getDynamicProperty('k')).toBe('v');
  });

  it('resolves an entity to a direct host keyed by its id', () => {
    const { resolve } = resolver();
    const entity = new EntityStub('-42', 'minecraft:armor_stand');
    const r = resolve.resolve(entity);

    expect(r).toMatchObject({ ok: true, kind: 'entity', identity: '-42', typeKey: 'entity:minecraft:armor_stand' });

    if (!r.ok) { return; }

    expect(r.host.caps.readableWhenUnloaded).toBe(false);
    r.host.write('k', 1);

    expect(entity.getDynamicProperty('k')).toBe(1);
    expect(r.host.keys()).toEqual(['k']);
  });

  it('resolves a slot holding a non-stackable item to a direct host', () => {
    const { resolve } = resolver();
    const slot = new SlotStub(new ItemStackStub('minecraft:diamond_sword', 1));
    const r = resolve.resolve(slot);

    expect(r).toMatchObject({ ok: true, kind: 'slot', typeKey: 'slot:minecraft:diamond_sword' });

    if (!r.ok) { return; }

    r.host.write('k', true);

    expect(slot.getDynamicProperty('k')).toBe(true);
  });

  it('resolves a block with a dynamic-properties component to a component host', () => {
    const { resolve } = resolver();
    const component = new ComponentStub();
    const block = new BlockStub('papi:elevator', { x: 1, y: 2, z: 3 }, { id: 'minecraft:overworld' }, component);
    const r = resolve.resolve(block);

    expect(r).toMatchObject({ ok: true, kind: 'block', identity: 'minecraft:overworld:1,2,3:papi:elevator', typeKey: 'block:papi:elevator' });

    if (!r.ok) { return; }

    expect(r.host.abi).toBe('component');
    expect(r.host.caps).toMatchObject({ own: true, enumerable: false, batch: false, budget: COMPONENT_BUDGET });
    expect(r.host.keys()).toBeUndefined();
    r.host.write('doc', '{}');

    expect(component.get('doc')).toBe('{}');
  });
});

// ─── Proxied hosts ─────────────────────────────────────────────────────────────

describe('proxied hosts', () => {
  it('proxies a dimension onto the world under an identity prefix', () => {
    const { world, resolve } = resolver();
    const r = resolve.resolve(new DimensionStub('minecraft:nether'));

    expect(r).toMatchObject({ ok: true, kind: 'dimension', identity: 'minecraft:nether' });

    if (!r.ok) { return; }

    expect(r.host.abi).toBe('proxied');
    expect(r.host.caps).toMatchObject({ own: false, enumerable: true, readableWhenUnloaded: true });
    r.host.write('doc', 'x');

    expect(world.getDynamicProperty('core-db:ns:dimension:minecraft:nether:doc')).toBe('x');
    expect(r.host.keys()).toEqual(['doc']);
  });

  it('proxies a vanilla block and keeps keys per block', () => {
    const { world, resolve } = resolver();
    const a = resolve.resolve(new BlockStub('minecraft:stone', { x: 0, y: 0, z: 0 }, { id: 'minecraft:overworld' }, undefined));
    const b = resolve.resolve(new BlockStub('minecraft:stone', { x: 0, y: 0, z: 1 }, { id: 'minecraft:overworld' }, undefined));

    if (!a.ok || !b.ok) { throw new Error('expected both to resolve'); }

    a.host.write('doc', 'A');
    b.host.write('doc', 'B');

    expect(a.host.read('doc')).toBe('A');
    expect(b.host.read('doc')).toBe('B');
    expect(a.host.keys()).toEqual(['doc']);
    expect(world.getDynamicPropertyIds()).toHaveLength(2);
  });

  it('a block of another type at the same position never inherits the document', () => {
    const { resolve } = resolver();
    const at = { x: 5, y: 64, z: 5 };
    const dim = { id: 'minecraft:overworld' };
    const stone = resolve.resolve(new BlockStub('minecraft:stone', at, dim, undefined));

    if (!stone.ok) { throw new Error('expected stone to resolve'); }

    stone.host.write('doc', 'stone-data');

    const dirt = resolve.resolve(new BlockStub('minecraft:dirt', at, dim, undefined));

    if (!dirt.ok) { throw new Error('expected dirt to resolve'); }

    expect(dirt.host.read('doc')).toBeUndefined();
    expect(dirt.host.keys()).toEqual([]);
    expect(stone.identity).toBe('minecraft:overworld:5,64,5:minecraft:stone');
    expect(dirt.identity).toBe('minecraft:overworld:5,64,5:minecraft:dirt');
  });
});

// ─── The cache ─────────────────────────────────────────────────────────────────

describe('per-type cache', () => {
  it('probes a block type once and reuses the decision for every instance', () => {
    const { resolve } = resolver();
    const first = new BlockStub('papi:elevator', { x: 0, y: 0, z: 0 }, { id: 'd' }, new ComponentStub());
    const second = new BlockStub('papi:elevator', { x: 9, y: 9, z: 9 }, { id: 'd' }, new ComponentStub());

    resolve.resolve(first);
    resolve.resolve(second);

    expect(resolve.decision('block:papi:elevator')).toBe('component');
    // The decision is cached; the component itself is fetched per instance because it is bound to one block.
    expect(first.getComponent).toHaveBeenCalledTimes(1);
    expect(second.getComponent).toHaveBeenCalledTimes(1);
  });

  it('never caches a throw', () => {
    const { resolve } = resolver();
    const block = new BlockStub('papi:elevator', { x: 0, y: 0, z: 0 }, { id: 'd' }, new ComponentStub());

    block.getComponent.mockImplementationOnce(() => { throw new Error('LocationInUnloadedChunkError'); });

    const unloaded = resolve.resolve(block);

    expect(unloaded.ok).toBe(false);
    expect(resolve.decision('block:papi:elevator')).toBeUndefined();

    const loaded = resolve.resolve(block);

    expect(loaded.ok).toBe(true);
    expect(resolve.decision('block:papi:elevator')).toBe('component');
  });

  it('caches proxied for a type with no component', () => {
    const { resolve } = resolver();

    resolve.resolve(new BlockStub('minecraft:stone', { x: 0, y: 0, z: 0 }, { id: 'd' }, undefined));

    expect(resolve.decision('block:minecraft:stone')).toBe('proxied');
  });
});

// ─── Prefixing ─────────────────────────────────────────────────────────────────

describe('prefixed hosts', () => {
  it('keeps two collections on one target apart and hides foreign keys from keys()', () => {
    const { world, resolve } = resolver();

    world.setDynamicProperty('core-cfg:s:ns:taxRate', 0.05); // config's key space

    const r = resolve.resolve(world);

    if (!r.ok) { throw new Error('expected the world to resolve'); }

    const balances = prefixed(r.host, r.prefixFor('balances'));
    const events = prefixed(r.host, r.prefixFor('events'));

    balances.write('doc', 'B');
    events.write('doc', 'E');

    expect(balances.read('doc')).toBe('B');
    expect(events.read('doc')).toBe('E');
    expect(balances.keys()).toEqual(['doc']);
    expect(events.keys()).toEqual(['doc']);
    expect(world.getDynamicProperty('core-db:ns:world::balances:doc')).toBe('B');
  });

  it('a world collection named like a kind never sees the proxied documents of that kind', () => {
    const { world, resolve } = resolver();
    const dim = resolve.resolve(new DimensionStub('minecraft:nether'));
    const w = resolve.resolve(world);

    if (!dim.ok || !w.ok) { throw new Error('expected both to resolve'); }

    prefixed(dim.host, dim.prefixFor('events')).write('doc', 'proxied');

    const dimensionCollectionOnWorld = prefixed(w.host, w.prefixFor('dimension'));

    dimensionCollectionOnWorld.write('doc', 'own');

    expect(dimensionCollectionOnWorld.keys()).toEqual(['doc']);
    expect(dimensionCollectionOnWorld.read('doc')).toBe('own');
    expect(world.getDynamicProperty('core-db:ns:dimension:minecraft:nether:events:doc')).toBe('proxied');
    expect(world.getDynamicProperty('core-db:ns:world::dimension:doc')).toBe('own');
  });

  it('a proxied host is a prefixed world host with proxied capabilities', () => {
    const { world, resolve } = resolver();
    const r = resolve.resolve(new DimensionStub('minecraft:the_end'));

    if (!r.ok) { throw new Error('expected the dimension to resolve'); }

    const events = prefixed(r.host, r.prefixFor('events'));

    events.writeMany({ a: 1, b: 2 });

    expect(r.host.abi).toBe('proxied');
    expect(r.host.caps.own).toBe(false);
    expect(world.getDynamicProperty('core-db:ns:dimension:minecraft:the_end:events:a')).toBe(1);
    expect(events.keys()?.sort()).toEqual(['a', 'b']);
  });

  it('a block entity collection prefix is just the collection, to spare the 950-byte budget', () => {
    const { resolve } = resolver();
    const r = resolve.resolve(new BlockStub('papi:elevator', { x: 0, y: 0, z: 0 }, { id: 'd' }, new ComponentStub()));

    if (!r.ok) { throw new Error('expected the block to resolve'); }

    expect(r.prefixFor('elevators')).toBe('elevators:');
  });
});
