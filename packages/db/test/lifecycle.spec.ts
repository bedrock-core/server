import { describe, expect, it, vi } from 'vitest';
import { createDb, schema, type Db } from '../src/index';
import { EntityStub, WorldStub } from './stubs';

function fixture(): { world: WorldStub; db: Db; tasks: Set<() => void>; releases: ReturnType<typeof vi.fn>[]; detach: ReturnType<typeof vi.fn> } {
  const world = new WorldStub();
  const tasks = new Set<() => void>();
  const releases: ReturnType<typeof vi.fn>[] = [];
  const detach = vi.fn();
  const db = createDb({
    world, namespace: 'lifecycle',
    lifecycle: {
      schedule(callback) {
        tasks.add(callback);
        const cancel = vi.fn(() => { tasks.delete(callback); });

        releases.push(cancel);

        return cancel;
      },
      attach: () => detach,
    },
  });

  return { world, db, tasks, releases, detach };
}

describe('database lifetime', () => {
  it('flushes pending documents, detaches hooks and cancels index and document tasks', () => {
    const { db, tasks, releases, detach } = fixture();
    const values = db.collection<{ value: number }, EntityStub>('values', { schema: schema<{ value: number }>(), coalesce: true });
    const entity = new EntityStub('e', 'test:entity');
    const document = values.for(entity);
    const listener = vi.fn();
    const unsubscribe = document.subscribe(listener);

    document.set({ value: 2 });
    expect(tasks.size).toBe(2);
    db.stop();
    expect(entity.getDynamicProperty('core-db:lifecycle:entity::values:doc')).toBe('{"v":1,"d":{"value":2}}');
    expect(tasks.size).toBe(0);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
    expect(() => db.blockRemoved('overworld', { x: 0, y: 0, z: 0 }, 'test:block')).not.toThrow();
    expect(() => document.get()).toThrow('database is stopped');
    expect(() => document.set({ value: 3 })).toThrow('database is stopped');
    expect(() => document.subscribe(listener)).toThrow('database is stopped');
    expect(() => db.collection('later', { schema: schema() })).toThrow('database is stopped');
    unsubscribe();
    db.stop();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('releases every resource and flushes other collections when hook cleanup fails', () => {
    const { db, tasks, detach } = fixture();
    const entity = new EntityStub('e', 'test:entity');
    const first = db.collection<{ value: number }, EntityStub>('first', { schema: schema<{ value: number }>(), coalesce: true });
    const second = db.collection<{ value: number }, EntityStub>('second', { schema: schema<{ value: number }>(), coalesce: true });

    first.for(entity).set({ value: 1 });
    second.for(entity).set({ value: 2 });
    detach.mockImplementation(() => { throw new Error('detach failed'); });
    expect(() => db.stop()).toThrow(AggregateError);
    expect(tasks.size).toBe(0);
    expect(entity.getDynamicProperty('core-db:lifecycle:entity::second:doc')).toBe('{"v":1,"d":{"value":2}}');
    expect(() => db.stop()).not.toThrow();
  });
});
