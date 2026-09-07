/**
 * The shared tree and its registry, without the engine: the declaration compiles to leaves with
 * inherited markers, nodes read and write dotted keys through a backend, branches fire for any
 * child, and two registries over a synchronous fake bus behave as owner and peer — initial values,
 * shape announcement, owner-only writes, opened leaves, persistence written and restored.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../../sync/src/bus';
import { PROTOCOL_MAX } from '../../sync/src/constants';
import type { Envelope } from '../../sync/src/envelope';
import { State } from '../../sync/src/state';
import { leaf, open, persisted } from '../src/shared/markers';
import { SHARED_SHAPE_KEY, SharedRegistry, sharedDpKey, type PersistenceStore } from '../src/shared/shared-registry';
import { compileShared, materialize, type LeafSpec, type SharedBackend, type SharedTree } from '../src/shared/tree';

// ─── The declaration ───────────────────────────────────────────────────────────

const DEF = {
  spawnRate: 5,
  highScore: open(0),
  tags: ['a', 'b'],
  event: persisted({ name: 'none', active: false, votes: open(0) }),
  blob: leaf({ x: 1, y: 2 }),
};

describe('compileShared', () => {
  it('flattens to dotted leaves and inherits markers downward', () => {
    const leaves = compileShared(DEF);

    expect(leaves.map(l => l.path)).toEqual(['spawnRate', 'highScore', 'tags', 'event.name', 'event.active', 'event.votes', 'blob']);
    expect(leaves.find(l => l.path === 'highScore')).toMatchObject({ open: true, persisted: false, initial: 0 });
    expect(leaves.find(l => l.path === 'event.name')).toMatchObject({ open: false, persisted: true, initial: 'none' });
    expect(leaves.find(l => l.path === 'event.votes')).toMatchObject({ open: true, persisted: true });
    expect(leaves.find(l => l.path === 'tags')?.initial).toEqual(['a', 'b']);
    expect(leaves.find(l => l.path === 'blob')?.initial).toEqual({ x: 1, y: 2 });
  });

  it('refuses reserved names and dots', () => {
    expect(() => compileShared({ get: 1 })).toThrow(/reserved/);
    expect(() => compileShared({ a: { subscribe: 1 } })).toThrow(/a\.subscribe/);
    expect(() => compileShared({ 'a.b': 1 })).toThrow(/dot/);
  });
});

// ─── The tree over a fake backend ──────────────────────────────────────────────

function fakeBackend(): { backend: SharedBackend; values: Map<string, unknown>; emit(path: string, value: unknown): void; writes: LeafSpec[] } {
  const values = new Map<string, unknown>();
  const listeners = new Set<(path: string, value: unknown) => void>();
  const writes: LeafSpec[] = [];

  const emit = (path: string, value: unknown): void => {
    for (const listener of listeners) {
      listener(path, value);
    }
  };

  return {
    values,
    writes,
    emit,
    backend: {
      read: path => values.get(path),
      write: (path, value, spec): void => {
        values.set(path, value);
        writes.push(spec);
        emit(path, value);
      },
      onChange: (listener): Unsubscribe => {
        listeners.add(listener);

        return (): void => {
          listeners.delete(listener);
        };
      },
    },
  };
}

function tree(): { t: SharedTree<typeof DEF>; fake: ReturnType<typeof fakeBackend> } {
  const fake = fakeBackend();

  return { t: materialize(fake.backend, compileShared(DEF), true) as SharedTree<typeof DEF>, fake }; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}

describe('tree', () => {
  it('reads the declared value until the mirror has one, then the mirror', () => {
    const { t, fake } = tree();

    expect(t.spawnRate.get()).toBe(5);
    expect(t.event.name.get()).toBe('none');
    expect(t.event.get()).toEqual({ name: 'none', active: false, votes: 0 });

    fake.values.set('spawnRate', 9);
    expect(t.spawnRate.get()).toBe(9);
    expect(t.get()).toMatchObject({ spawnRate: 9, blob: { x: 1, y: 2 }, tags: ['a', 'b'] });
  });

  it('writes leaves, branches and patches through the backend with their specs', () => {
    const { t, fake } = tree();

    t.spawnRate.set(6);
    t.event.set({ name: 'race', active: true, votes: 1 });
    t.event.patch({ active: false });
    t.patch({ event: { votes: 2 } });

    expect(fake.values.get('spawnRate')).toBe(6);
    expect(fake.values.get('event.name')).toBe('race');
    expect(fake.values.get('event.active')).toBe(false);
    expect(fake.values.get('event.votes')).toBe(2);
    expect(fake.writes.map(w => w.path)).toEqual(['spawnRate', 'event.name', 'event.active', 'event.votes', 'event.active', 'event.votes']);
  });

  it('notifies a leaf, its branches and the root, and releases the backend when the last listener leaves', () => {
    const { t, fake } = tree();
    const leafSeen: unknown[] = [];
    const branchSeen: unknown[] = [];
    const rootSeen: unknown[] = [];
    const stopLeaf = t.event.active.subscribe(v => leafSeen.push(v));
    const stopBranch = t.event.subscribe(v => branchSeen.push(v));
    const stopRoot = t.subscribe(v => rootSeen.push(v));

    fake.values.set('event.active', true);
    fake.emit('event.active', true);
    fake.emit('spawnRate', 7);

    expect(leafSeen).toEqual([true]);
    expect(branchSeen).toHaveLength(1);
    expect(branchSeen[0]).toMatchObject({ active: true });
    expect(rootSeen).toHaveLength(2);

    stopLeaf();
    stopBranch();
    stopRoot();
    fake.emit('event.active', false);
    expect(leafSeen).toEqual([true]);
  });

  it('satisfies the observable shape', () => {
    const { t } = tree();
    const readonlyObservable: { get(): number; subscribe(l: (v: number) => void): Unsubscribe } = t.spawnRate;

    expect(readonlyObservable.get()).toBe(5);
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

function memoryStore(): PersistenceStore & { data: Map<string, string> } {
  const data = new Map<string, string>();

  return {
    data,
    read: key => data.get(key),
    write: (key, value): void => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
    },
  };
}

function realm(w: Wire, id: string, store = memoryStore()): { state: State; registry: SharedRegistry; store: ReturnType<typeof memoryStore>; deferred: (() => void)[]; tick(): void } {
  const state = new State(fakeBus(w, id), id);
  const deferred: (() => void)[] = [];

  state.start();

  const registry = new SharedRegistry({
    state,
    namespace: id,
    store,
    defer: (fn): void => {
      deferred.push(fn);
    },
    log: vi.fn(),
  });

  return {
    state,
    registry,
    store,
    deferred,
    tick: (): void => {
      for (const fn of deferred.splice(0)) {
        fn();
      }
    },
  };
}

describe('SharedRegistry', () => {
  it('writes initial values, announces the shape, and a peer reads through its typed tree', () => {
    const w = wire();
    const owner = realm(w, 'os_shop');
    const peer = realm(w, 'bt_hud');
    const shop = owner.registry.define({ stock: 3, sale: { active: false, percent: 0 } });

    expect(owner.state.get('os_shop', 'stock')).toBe(3);
    expect(owner.state.get('os_shop', SHARED_SHAPE_KEY)).toEqual({ 'stock': {}, 'sale.active': {}, 'sale.percent': {} });

    const mirror = peer.registry.of<{ stock: number; sale: { active: boolean; percent: number } }>('os_shop');

    expect(mirror).toBeDefined();
    expect(mirror?.stock.get()).toBe(3);
    expect(mirror?.sale.get()).toEqual({ active: false, percent: 0 });

    const seen: (number | undefined)[] = [];

    mirror?.stock.subscribe(n => seen.push(n));
    shop.stock.set(2);
    shop.sale.patch({ percent: 20 });

    expect(seen).toEqual([2]);
    expect(mirror?.sale.percent.get()).toBe(20);
    expect(peer.registry.of('nobody')).toBeUndefined();
    expect(peer.registry.of('os_shop')).toBe(mirror);
  });

  it('a peer writes only what the owner opened', () => {
    const w = wire();
    const owner = realm(w, 'os_shop');
    const peer = realm(w, 'bt_hud');

    owner.registry.define({ stock: 3, votes: open(0) });

    const mirror = peer.registry.of<{ stock: number; votes: ReturnType<typeof open<number>> }>('os_shop');

    mirror?.votes.set(5);
    expect(owner.state.get('os_shop', 'votes')).toBe(5);

    const closed: { set?(value: number): void } | undefined = mirror?.stock;

    expect(() => closed?.set?.(1)).toThrow(/did not open/);
    expect(owner.state.get('os_shop', 'stock')).toBe(3);
  });

  it('persists marked leaves on write and restores them one tick after registration', () => {
    const w = wire();
    const store = memoryStore();
    const first = realm(w, 'os_shop', store);
    const tree = first.registry.define({ stock: 3, event: persisted({ name: 'none', active: false }) });

    // Persisted leaves are not written before the world is readable; the tree still answers.
    expect(first.state.get('os_shop', 'event.name')).toBeUndefined();
    expect(tree.event.name.get()).toBe('none');

    first.tick();
    expect(first.state.get('os_shop', 'event.name')).toBe('none');
    expect(store.data.size).toBe(0);

    tree.event.set({ name: 'race', active: true });
    expect(store.data.get(sharedDpKey('os_shop', 'event.name'))).toBe('"race"');
    expect(store.data.get(sharedDpKey('os_shop', 'event.active'))).toBe('true');
    expect(store.data.has(sharedDpKey('os_shop', 'stock'))).toBe(false);

    // A new session: same store, fresh mirror.
    const second = realm(wire(), 'os_shop', store);
    const restored = second.registry.define({ stock: 3, event: persisted({ name: 'none', active: false }) });

    second.tick();
    expect(restored.event.get()).toEqual({ name: 'race', active: true });
    expect(restored.stock.get()).toBe(3);
  });

  it('refuses a second declaration', () => {
    const owner = realm(wire(), 'os_shop');

    owner.registry.define({ a: 1 });
    expect(() => owner.registry.define({ b: 2 })).toThrow(/already/);
  });
});
