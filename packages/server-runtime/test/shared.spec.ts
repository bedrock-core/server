/**
 * The shared tree and its registry, without the engine: a node reads the mirror and falls back to
 * the declared value, notifies with the new value and the one before it, holds one backend
 * subscription for as long as it has listeners, and isolates a listener that throws. Two
 * registries over a synchronous fake bus behave as owner and peer — initial values, the announced
 * key names, and a peer that can read everything and write nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../../sync/src/bus';
import { PROTOCOL_MAX } from '../../sync/src/constants';
import type { Envelope } from '../../sync/src/envelope';
import { State } from '../../sync/src/state';
import { materialize, type SharedBackend, type SharedTree } from '../src/shared/tree';

// The registry reaches `stateKey` through the sync barrel, which imports the engine; none of it runs here.
vi.mock('@minecraft/server', () => ({ system: {} }));

const { SharedRegistry } = await import('../src/shared/shared-registry');

const DEF = {
  spawnRate: 5,
  tags: ['a', 'b'],
  event: { name: 'none', active: false },
};

// ─── The tree over a fake backend ──────────────────────────────────────────────

interface Fake {
  backend: SharedBackend;
  values: Map<string, unknown>;
  emit(key: string): void;
  /** How many backend subscriptions are open right now. */
  readonly attached: number;
}

function fakeBackend(): Fake {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();

  const fake: Fake = {
    values,
    emit: (key): void => {
      for (const listener of [...listeners.get(key) ?? []]) { listener(); }
    },
    get attached(): number {
      let total = 0;

      for (const set of listeners.values()) { total += set.size; }

      return total;
    },
    backend: {
      read: key => values.get(key),
      write: (key, value): void => {
        values.set(key, value);
        fake.emit(key);
      },
      onChange: (key, listener): Unsubscribe => {
        let set = listeners.get(key);

        if (set === undefined) {
          set = new Set();
          listeners.set(key, set);
        }

        set.add(listener);

        return (): void => { set.delete(listener); };
      },
    },
  };

  return fake;
}

function tree(): { t: SharedTree<typeof DEF>; fake: Fake } {
  const fake = fakeBackend();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return { t: materialize(fake.backend, Object.keys(DEF), DEF) as SharedTree<typeof DEF>, fake };
}

describe('tree', () => {
  it('reads the declared value until the mirror has one, then the mirror', () => {
    const { t, fake } = tree();

    expect(t.spawnRate.get()).toBe(5);
    expect(t.tags.get()).toEqual(['a', 'b']);
    expect(t.event.get()).toEqual({ name: 'none', active: false });

    fake.values.set('spawnRate', 9);
    expect(t.spawnRate.get()).toBe(9);
  });

  it('writes whole values through the backend, an object included', () => {
    const { t, fake } = tree();

    t.spawnRate.set(6);
    t.event.set({ name: 'race', active: true });

    expect(fake.values.get('spawnRate')).toBe(6);
    expect(fake.values.get('event')).toEqual({ name: 'race', active: true });
  });

  it('notifies with the new value and the previous one, and only for its own key', () => {
    const { t, fake } = tree();
    const seen: [number, number][] = [];

    t.spawnRate.subscribe((next, prev) => { seen.push([next, prev]); });
    t.event.subscribe(() => { throw new Error('the sibling must not fire'); });

    t.spawnRate.set(6);
    t.spawnRate.set(7);

    expect(seen).toEqual([[6, 5], [7, 6]]);
    expect(fake.values.get('event')).toBeUndefined();
  });

  it('holds one backend subscription while it has listeners, and drops it with the last', () => {
    const { t, fake } = tree();
    const stopA = t.spawnRate.subscribe(() => {});
    const stopB = t.spawnRate.subscribe(() => {});

    expect(fake.attached).toBe(1);

    stopA();
    expect(fake.attached).toBe(1);

    stopB();
    expect(fake.attached).toBe(0);

    // Releasing twice is a no-op, not a second decrement.
    stopB();
    expect(fake.attached).toBe(0);
  });

  it('isolates a listener that throws', () => {
    const { t } = tree();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: number[] = [];

    t.spawnRate.subscribe(() => { throw new Error('boom'); });
    t.spawnRate.subscribe((next) => { seen.push(next); });

    expect(() => { t.spawnRate.set(6); }).not.toThrow();
    expect(seen).toEqual([6]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawnRate'));

    warn.mockRestore();
  });

  it('satisfies the observable shape', () => {
    const { t } = tree();
    const readable: { get(): number; subscribe(l: (next: number, prev: number) => void): Unsubscribe } = t.spawnRate;

    expect(readable.get()).toBe(5);
  });
});

// ─── Two registries over a fake bus ────────────────────────────────────────────

interface Wire {
  attach(id: string, handlers: Map<string, Set<EnvelopeHandler>>): void;
  deliver(from: string, dst: string | undefined, type: string, data: unknown): void;
}

function wire(): Wire {
  const nodes = new Map<string, Map<string, Set<EnvelopeHandler>>>();

  return {
    attach: (id, handlers): void => {
      nodes.set(id, handlers);
    },
    deliver: (from, dst, type, data): void => {
      const envelope: Envelope = { v: PROTOCOL_MAX, src: from, iid: `${from}-iid`, type, mid: `${from}/${Math.random()}`, data };

      for (const [id, handlers] of nodes) {
        if (id === from || (dst !== undefined && dst !== id)) {
          continue;
        }

        for (const handler of handlers.get(type) ?? []) {
          handler(envelope);
        }
      }
    },
  };
}

function fakeBus(w: Wire, id: string): Bus {
  const handlers = new Map<string, Set<EnvelopeHandler>>();

  w.attach(id, handlers);

  const bus = {
    on: (type: string, handler: EnvelopeHandler): Unsubscribe => {
      let set = handlers.get(type);

      if (set === undefined) {
        set = new Set();
        handlers.set(type, set);
      }

      set.add(handler);

      return (): void => {
        set.delete(handler);
      };
    },
    send: (options: { dst?: string; type: string; data?: unknown }): string => {
      w.deliver(id, options.dst, options.type, options.data);

      return 'mid';
    },
  };

  return bus as unknown as Bus; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}

function realm(w: Wire, id: string): { state: State; registry: SharedRegistry } {
  const state = new State(fakeBus(w, id), id);

  state.start();

  return { state, registry: new SharedRegistry({ state, namespace: id }) };
}

interface ShopShared {
  stock: number;
  sale: { active: boolean; percent: number };
}

describe('SharedRegistry', () => {
  it('writes initial values, announces the key names, and a peer reads through its typed tree', () => {
    const w = wire();
    const owner = realm(w, 'os_shop');
    const peer = realm(w, 'bt_hud');
    const shop = owner.registry.define<ShopShared>({ stock: 3, sale: { active: false, percent: 0 } });

    expect(owner.state.get('os_shop', 'stock')).toBe(3);
    expect(owner.state.get('os_shop', 'core-shared/shape')).toEqual(['stock', 'sale']);

    const mirror = peer.registry.of<ShopShared>('os_shop');

    expect(mirror).toBeDefined();
    expect(mirror?.stock.get()).toBe(3);
    expect(mirror?.sale.get()).toEqual({ active: false, percent: 0 });

    const seen: (number | undefined)[] = [];

    mirror?.stock.subscribe(n => seen.push(n));
    shop.stock.set(2);
    shop.sale.set({ active: true, percent: 20 });

    expect(seen).toEqual([2]);
    expect(mirror?.sale.get()).toEqual({ active: true, percent: 20 });
    expect(owner.registry.own).toBe(shop);
  });

  it('has no tree for an addon that has announced nothing, and reuses the one it built', () => {
    const w = wire();
    const owner = realm(w, 'os_shop');
    const peer = realm(w, 'bt_hud');

    expect(peer.registry.of('os_shop')).toBeUndefined();

    owner.registry.define({ stock: 3 });

    const mirror = peer.registry.of('os_shop');

    expect(mirror).toBeDefined();
    expect(peer.registry.of('os_shop')).toBe(mirror);
    expect(peer.registry.of('nobody')).toBeUndefined();
  });

  it('gives a peer no way to write, and the mirror refuses one that tries anyway', () => {
    const w = wire();
    const owner = realm(w, 'os_shop');
    const peer = realm(w, 'bt_hud');

    owner.registry.define({ stock: 3 });

    const mirror = peer.registry.of<{ stock: number }>('os_shop');
    const forced: { set?(value: number): void } | undefined = mirror?.stock;

    expect(forced?.set).toBeTypeOf('function');
    expect(() => forced?.set?.(1)).toThrow(/only its owner/);

    // Even reaching past the tree to the mirror itself changes nothing anywhere.
    peer.state.set('os_shop', 'stock', 99);
    expect(owner.state.get('os_shop', 'stock')).toBe(3);
    expect(peer.state.get('os_shop', 'stock')).toBe(3);
    expect(peer.state.droppedForeign).toBe(1);
  });

  it('refuses a second declaration and a key in the framework prefix', () => {
    const w = wire();
    const owner = realm(w, 'os_shop');

    expect(() => owner.registry.define({ 'core-shared/shape': 1 })).toThrow(/reserved/);

    owner.registry.define({ stock: 3 });
    expect(() => owner.registry.define({ other: 1 })).toThrow(/already declared/);
  });
});
