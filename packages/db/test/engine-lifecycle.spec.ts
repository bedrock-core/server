import { afterEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  loads: new Set<(event: { entity: { isValid: boolean } }) => void>(),
  spawns: new Set<(event: { player: { isValid: boolean }; initialSpawn: boolean }) => void>(),
  leaves: new Set<(event: { player: unknown }) => void>(),
  tasks: new Map<number, () => void>(),
  next: 0,
}));

vi.mock('@minecraft/server', () => {
  class NativeStub {}

  return {
    Block: NativeStub, ContainerSlot: NativeStub, Dimension: NativeStub,
    Entity: NativeStub, ItemStack: NativeStub, World: NativeStub,
    system: {
      run: (callback: () => void): number => {
        const id = ++engine.next;

        engine.tasks.set(id, callback);

        return id;
      },
      clearRun: (id: number): void => { engine.tasks.delete(id); },
    },
    world: {
      afterEvents: {
        playerSpawn: {
          subscribe: (callback: (event: { player: { isValid: boolean }; initialSpawn: boolean }) => void): typeof callback => {
            engine.spawns.add(callback);

            return callback;
          },
          unsubscribe: (callback: (event: { player: { isValid: boolean }; initialSpawn: boolean }) => void): void => { engine.spawns.delete(callback); },
        },
        entityLoad: {
          subscribe: (callback: (event: { entity: { isValid: boolean } }) => void): typeof callback => {
            engine.loads.add(callback);

            return callback;
          },
          unsubscribe: (callback: (event: { entity: { isValid: boolean } }) => void): void => { engine.loads.delete(callback); },
        } },
      beforeEvents: { playerLeave: {
        subscribe: (callback: (event: { player: unknown }) => void): typeof callback => {
          engine.leaves.add(callback);

          return callback;
        },
        unsubscribe: (callback: (event: { player: unknown }) => void): void => { engine.leaves.delete(callback); },
      } },
    },
  };
});

const { engineLifecycle } = await import('../src/minecraft');
const { world } = await import('@minecraft/server');

afterEach(() => {
  vi.restoreAllMocks();
  engine.loads.clear();
  engine.spawns.clear();
  engine.leaves.clear();
  engine.tasks.clear();
});

describe('engine lifecycle ownership', () => {
  it('cancels scheduled work and removes the exact SDK callbacks on disposal', () => {
    const cancel = engineLifecycle.schedule(vi.fn());
    const detach = engineLifecycle.attach({ loaded: vi.fn(), leaving: vi.fn() });

    expect(engine.tasks.size).toBe(1);
    expect(engine.loads.size).toBe(1);
    expect(engine.spawns.size).toBe(1);
    expect(engine.leaves.size).toBe(1);
    cancel();
    detach();
    detach();
    expect(engine.tasks.size).toBe(0);
    expect(engine.loads.size).toBe(0);
    expect(engine.spawns.size).toBe(0);
    expect(engine.leaves.size).toBe(0);
  });

  it('recovers valid entities and players on both initial spawn and respawn', () => {
    const loaded = vi.fn();
    const detach = engineLifecycle.attach({ loaded, leaving: vi.fn() });
    const entity = { isValid: true };
    const player = { isValid: true };

    for (const load of engine.loads) { load({ entity }); }

    for (const spawn of engine.spawns) {
      spawn({ player, initialSpawn: true });
      spawn({ player, initialSpawn: false });
      spawn({ player: { isValid: false }, initialSpawn: true });
    }

    for (const load of engine.loads) { load({ entity: { isValid: false } }); }

    expect(loaded.mock.calls).toEqual([[entity], [player], [player]]);
    detach();
  });

  it('rolls back entity loading if player-spawn subscription fails', () => {
    vi.spyOn(world.afterEvents.playerSpawn, 'subscribe').mockImplementation(() => { throw new Error('spawn attach failed'); });
    expect(() => engineLifecycle.attach({ loaded: vi.fn(), leaving: vi.fn() })).toThrow('spawn attach failed');
    expect(engine.loads.size).toBe(0);
    expect(engine.spawns.size).toBe(0);
    expect(engine.leaves.size).toBe(0);
  });

  it('rolls back load subscriptions if the leave subscription fails', () => {
    vi.spyOn(world.beforeEvents.playerLeave, 'subscribe').mockImplementation(() => { throw new Error('attach failed'); });
    expect(() => engineLifecycle.attach({ loaded: vi.fn(), leaving: vi.fn() })).toThrow('attach failed');
    expect(engine.loads.size).toBe(0);
    expect(engine.spawns.size).toBe(0);
  });

  it('attempts all remaining unsubscriptions when one cleanup throws', () => {
    const detach = engineLifecycle.attach({ loaded: vi.fn(), leaving: vi.fn() });
    const leave = vi.spyOn(world.beforeEvents.playerLeave, 'unsubscribe').mockImplementation(() => { throw new Error('detach failed'); });

    expect(detach).toThrow(AggregateError);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(engine.loads.size).toBe(0);
    expect(engine.spawns.size).toBe(0);
    expect(() => detach()).not.toThrow();
  });
});
