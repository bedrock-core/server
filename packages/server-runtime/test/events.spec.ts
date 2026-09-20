/**
 * The events registry over the sync layer: the owner's tree emits and hears its own, a peer's tree
 * hears the owner's, a peer's tree exists for an addon that has announced nothing, and neither
 * tree offers a way to emit under someone else's namespace.
 */
import { describe, expect, it } from 'vitest';
import { Events } from '../../sync/src/events';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../../sync/src/bus';
import { PROTOCOL_MAX } from '../../sync/src/constants';
import type { Envelope } from '../../sync/src/envelope';
import { EventsRegistry } from '../src/events/events-registry';
import { event } from '../src/events/tree';

interface Wire {
  attach(id: string, handlers: Map<string, Set<EnvelopeHandler>>): void;
  deliver(from: string, type: string, data: unknown): void;
}

function wire(): Wire {
  const nodes = new Map<string, Map<string, Set<EnvelopeHandler>>>();

  return {
    attach: (id, handlers): void => { nodes.set(id, handlers); },
    deliver: (from, type, data): void => {
      const envelope: Envelope = { v: PROTOCOL_MAX, src: from, iid: `${from}-iid`, type, mid: `${from}/1`, data };

      for (const [id, handlers] of nodes) {
        if (id === from) { continue; }

        for (const handler of handlers.get(type) ?? []) { handler(envelope); }
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

      return (): void => { set.delete(handler); };
    },
    send: (options: { type: string; data?: unknown }): string => {
      w.deliver(id, options.type, options.data);

      return 'mid';
    },
  };

  return bus as unknown as Bus; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
}

function realm(w: Wire, id: string): EventsRegistry {
  const events = new Events(fakeBus(w, id), id);

  events.start();

  return new EventsRegistry({ events, namespace: id });
}

const DEF = {
  purchase: event<{ playerId: string; gold: number }>(),
  levelUp: event<{ playerId: string; level: number }>(),
};

describe('EventsRegistry', () => {
  it('delivers the owner an event to itself and to a peer, in the same tick', () => {
    const w = wire();
    const owner = realm(w, 'drav0011_economy');
    const peer = realm(w, 'os_shop');
    const economy = owner.define(DEF);
    const here: unknown[] = [];
    const there: unknown[] = [];
    const senders: string[] = [];

    economy.purchase.subscribe(payload => here.push(payload));
    peer.of<typeof DEF>('drav0011_economy').purchase.subscribe((payload, from) => {
      there.push(payload);
      senders.push(from);
    });

    economy.purchase.emit({ playerId: 'p1', gold: 5 });

    expect(here).toEqual([{ playerId: 'p1', gold: 5 }]);
    expect(there).toEqual([{ playerId: 'p1', gold: 5 }]);
    expect(senders).toEqual(['drav0011_economy']);
  });

  it('fires only the name that was announced', () => {
    const w = wire();
    const owner = realm(w, 'drav0011_economy');
    const peer = realm(w, 'os_shop');
    const economy = owner.define(DEF);
    const seen: string[] = [];
    const tree = peer.of<typeof DEF>('drav0011_economy');

    tree.purchase.subscribe(() => seen.push('purchase'));
    tree.levelUp.subscribe(() => seen.push('levelUp'));

    economy.levelUp.emit({ playerId: 'p1', level: 2 });

    expect(seen).toEqual(['levelUp']);
  });

  it('hands out a tree for an addon that is not in the world, and it fires when it arrives', () => {
    const w = wire();
    const peer = realm(w, 'os_shop');
    const seen: unknown[] = [];

    // Nobody has registered this namespace yet — an event missed is missed for good, so the
    // listener has to be attachable first.
    peer.of<typeof DEF>('drav0011_economy').purchase.subscribe(payload => seen.push(payload));

    const owner = realm(w, 'drav0011_economy');

    owner.define(DEF).purchase.emit({ playerId: 'p1', gold: 1 });

    expect(seen).toEqual([{ playerId: 'p1', gold: 1 }]);
    expect(peer.of('drav0011_economy')).toBe(peer.of('drav0011_economy'));
  });

  it('releases a listener, and refuses a second declaration', () => {
    const w = wire();
    const owner = realm(w, 'drav0011_economy');
    const economy = owner.define(DEF);
    const seen: unknown[] = [];
    const release = economy.purchase.subscribe(payload => seen.push(payload));

    economy.purchase.emit({ playerId: 'p1', gold: 1 });
    release();
    economy.purchase.emit({ playerId: 'p1', gold: 2 });

    expect(seen).toEqual([{ playerId: 'p1', gold: 1 }]);
    expect(owner.own).toBe(economy);
    expect(() => owner.define(DEF)).toThrow(/already declared/);
  });

  it('gives a peer no way to emit under the owner namespace', () => {
    const w = wire();
    const owner = realm(w, 'drav0011_economy');
    const peer = realm(w, 'os_shop');
    const economy = owner.define(DEF);
    const seen: unknown[] = [];
    const foreign: { emit?(payload: unknown): void } = peer.of<typeof DEF>('drav0011_economy').purchase;

    economy.purchase.subscribe(payload => seen.push(payload));

    expect(foreign.emit).toBeUndefined();

    // The escape hatch listens; it never announces.
    peer.on('drav0011_economy', 'purchase', payload => seen.push(payload));
    economy.purchase.emit({ playerId: 'p1', gold: 3 });

    expect(seen).toEqual([{ playerId: 'p1', gold: 3 }, { playerId: 'p1', gold: 3 }]);
  });
});
