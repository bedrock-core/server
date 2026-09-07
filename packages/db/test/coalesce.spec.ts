/**
 * Write-behind: many writes, one property write per flush; a flush that finds the entity away parks
 * the document and writes it on load; a leaving player is flushed at once; a block or slot is
 * refused; a db with no coalescing collection never touches the lifecycle.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDb, schema } from '../src/index';
import type { Collection, Lifecycle, Schema } from '../src/index';
import { BlockStub, ComponentStub, EntityStub, WorldStub } from './stubs';

interface Counter {
  hits: number;
}

interface LooseDb {
  collection<T extends object>(name: string, options: { schema: Schema<T>; coalesce?: boolean }): Collection<T, unknown>;
  flush(target?: unknown): void;
}

function harness(parkFor?: number): {
  world: WorldStub;
  entities: Map<string, EntityStub>;
  db: LooseDb;
  tick(): void;
  hooks(): { loaded(target: unknown): void; leaving(target: unknown): void } | undefined;
  lifecycle: { schedule: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> };
  log: ReturnType<typeof vi.fn<(message: string) => void>>;
} {
  const world = new WorldStub();
  const entities = new Map<string, EntityStub>();
  const scheduled: (() => void)[] = [];
  let attachedHooks: { loaded(target: unknown): void; leaving(target: unknown): void } | undefined;
  const lifecycle = {
    schedule: vi.fn((flush: () => void) => {
      scheduled.push(flush);
    }),
    attach: vi.fn((hooks: { loaded(target: unknown): void; leaving(target: unknown): void }) => {
      attachedHooks = hooks;
    }),
  };
  const log = vi.fn<(message: string) => void>();
  const db: LooseDb = createDb({
    world,
    namespace: 'ns',
    lifecycle: lifecycle satisfies Lifecycle,
    parkFor,
    log,
    locate: {
      bind: target => (): unknown => (target instanceof EntityStub ? entities.get(target.id) : target),
      fromIdentity: (kind, identity): unknown => (kind === 'entity' ? entities.get(identity) : undefined),
    },
  });

  return {
    world,
    entities,
    db,
    lifecycle,
    log,
    tick: (): void => {
      for (const flush of scheduled.splice(0)) {
        flush();
      }
    },
    hooks: () => attachedHooks,
  };
}

describe('coalesce', () => {
  it('writes once per flush however many times the document changed', () => {
    const { entities, db, tick, lifecycle } = harness();
    const counters = db.collection('counters', { schema: schema<Counter>(), coalesce: true });
    const mob = new EntityStub('m', 'ns:mob');

    entities.set('m', mob);

    const spy = vi.spyOn(mob, 'setDynamicProperty');

    for (let i = 1; i <= 100; i++) {
      counters.for(mob).patch({ hits: i });
    }

    expect(counters.for(mob).get()).toEqual({ hits: 100 });
    expect(spy).not.toHaveBeenCalled();
    expect(lifecycle.schedule).toHaveBeenCalledTimes(1);

    tick();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(mob.getDynamicProperty('core-db:ns:entity::counters:doc')).toBe('{"v":1,"d":{"hits":100}}');
  });

  it('parks a document whose entity left before the flush and writes it when the entity loads', () => {
    const { entities, db, tick, hooks } = harness();
    const counters = db.collection('counters', { schema: schema<Counter>(), coalesce: true });
    const mob = new EntityStub('m', 'ns:mob');

    entities.set('m', mob);
    counters.for(mob).set({ hits: 7 });
    entities.delete('m');
    tick();

    expect(mob.getDynamicProperty('core-db:ns:entity::counters:doc')).toBeUndefined();

    const back = new EntityStub('m', 'ns:mob');

    entities.set('m', back);
    hooks()?.loaded(back);

    expect(back.getDynamicProperty('core-db:ns:entity::counters:doc')).toBe('{"v":1,"d":{"hits":7}}');
  });

  it('drops a parked document past its time, with a log line', () => {
    const { entities, db, tick, hooks, log } = harness(0);
    const counters = db.collection('counters', { schema: schema<Counter>(), coalesce: true });
    const mob = new EntityStub('m', 'ns:mob');
    const other = new EntityStub('o', 'ns:mob');

    entities.set('m', mob);
    counters.for(mob).set({ hits: 1 });
    entities.delete('m');
    tick();

    // Any later load sweeps the parked set.
    entities.set('o', other);
    hooks()?.loaded(other);

    const back = new EntityStub('m', 'ns:mob');

    entities.set('m', back);
    hooks()?.loaded(back);

    expect(back.getDynamicProperty('core-db:ns:entity::counters:doc')).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('parked');
  });

  it('flushes a leaving player at once, and only that player', () => {
    const { entities, db, hooks } = harness();
    const counters = db.collection('counters', { schema: schema<Counter>(), coalesce: true });
    const leaving = new EntityStub('p1', 'minecraft:player');
    const staying = new EntityStub('p2', 'minecraft:player');

    entities.set('p1', leaving);
    entities.set('p2', staying);
    counters.for(leaving).set({ hits: 1 });
    counters.for(staying).set({ hits: 2 });

    hooks()?.leaving(leaving);

    expect(leaving.getDynamicProperty('core-db:ns:entity::counters:doc')).toBe('{"v":1,"d":{"hits":1}}');
    expect(staying.getDynamicProperty('core-db:ns:entity::counters:doc')).toBeUndefined();

    db.flush();
    expect(staying.getDynamicProperty('core-db:ns:entity::counters:doc')).toBe('{"v":1,"d":{"hits":2}}');
  });

  it('coalesces on the world, refuses a block entity and a slot', () => {
    const { world, db, tick } = harness();
    const counters = db.collection('counters', { schema: schema<Counter>(), coalesce: true });
    const lift = new BlockStub('papi:elevator', { x: 0, y: 0, z: 0 }, { id: 'overworld' }, new ComponentStub());

    counters.for(world).set({ hits: 3 });
    expect(world.getDynamicProperty('core-db:ns:world::counters:doc')).toBeUndefined();
    tick();
    expect(world.getDynamicProperty('core-db:ns:world::counters:doc')).toBe('{"v":1,"d":{"hits":3}}');

    expect(counters.where(lift)).toMatchObject({ ok: false, reason: expect.stringContaining('coalesce') });
  });

  it('a delete cancels a pending write', () => {
    const { entities, db, tick } = harness();
    const counters = db.collection('counters', { schema: schema<Counter>(), coalesce: true });
    const mob = new EntityStub('m', 'ns:mob');

    entities.set('m', mob);
    counters.for(mob).set({ hits: 1 });
    counters.for(mob).delete();
    tick();

    expect(mob.getDynamicPropertyIds()).toEqual([]);
    expect(counters.size).toBe(0);
  });

  it('never attaches to the lifecycle without a coalescing collection', () => {
    const { db, lifecycle, entities } = harness();
    const plain = db.collection('plain', { schema: schema<Counter>() });
    const mob = new EntityStub('m', 'ns:mob');

    entities.set('m', mob);
    plain.for(mob).set({ hits: 1 });

    expect(lifecycle.attach).not.toHaveBeenCalled();
    expect(lifecycle.schedule).not.toHaveBeenCalled();
    expect(mob.getDynamicProperty('core-db:ns:entity::plain:doc')).toBe('{"v":1,"d":{"hits":1}}');
  });
});
