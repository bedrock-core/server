/**
 * Discovery as a value. The peer list is an observable, and the assertions here are about when it
 * republishes: a node arriving or leaving is news, a heartbeat that repeats what the peer already
 * said is not. That distinction is what lets a listener sit on `peers` without waking every five
 * seconds per peer, so it is the part worth pinning down. The engine is faked down to the three
 * members discovery uses — the tick, the interval, and cancelling one.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../src/bus';
import { MessageType, PROTOCOL_MAX, PROTOCOL_MIN, SELF_CAPS } from '../src/constants';
import type { Envelope } from '../src/envelope';

const engine = vi.hoisted(() => ({ tick: 0, intervals: [] as { fn: () => void; period: number }[] }));

vi.mock('@minecraft/server', () => ({
  system: {
    get currentTick(): number {
      return engine.tick;
    },
    runInterval: (fn: () => void, period: number): number => engine.intervals.push({ fn, period }),
    clearRun: (): void => { /* nothing to cancel in the fake */ },
  },
}));

const { Discovery } = await import('../src/discovery');
const { PEER_TTL_TICKS } = await import('../src/constants');

/** A `Bus` double with only the members `Discovery` reaches for. */
function fakeBus(selfId: string): { bus: Bus; announce: (src: string, data: unknown) => void } {
  const handlers = new Map<string, Set<EnvelopeHandler>>();

  const bus = {
    selfId,
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
    send: (): string => 'mid',
    setPeerProtocol: (): void => { /* the bus's encoding table is not under test */ },
    forgetPeer: (): void => { /* likewise */ },
  };

  const announce = (src: string, data: unknown): void => {
    const envelope: Envelope = {
      v: PROTOCOL_MIN,
      src,
      iid: `${src}-iid`,
      type: MessageType.Announce,
      mid: `${src}/1`,
      data,
    };

    for (const handler of handlers.get(MessageType.Announce) ?? []) { handler(envelope); }
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return { bus: bus as unknown as Bus, announce };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: '1.0.0', schemaVersion: 1, pmin: PROTOCOL_MIN, pmax: PROTOCOL_MAX, caps: SELF_CAPS, ...overrides };
}

function setup(): {
  discovery: InstanceType<typeof Discovery>;
  announce: (src: string, data: unknown) => void;
  sweep: () => void;
} {
  engine.tick = 0;
  engine.intervals = [];

  const { bus, announce } = fakeBus('self');
  const discovery = new Discovery(bus);

  discovery.start();

  const sweep = engine.intervals.find(entry => entry.period === 40);

  if (sweep === undefined) { throw new Error('discovery did not register its sweep'); }

  return { discovery, announce, sweep: sweep.fn };
}

describe('Discovery.peers', () => {
  it('publishes a new peer and reports it as up', () => {
    const { discovery, announce } = setup();
    const seen: number[] = [];

    discovery.peers.subscribe(peers => seen.push(peers.length));

    const up = vi.fn();

    discovery.onPeerUp(up);
    announce('a', payload());

    expect(seen).toEqual([1]);
    expect(up).toHaveBeenCalledTimes(1);
    expect(discovery.peers.get().map(peer => peer.id)).toEqual(['a']);
  });

  it('stays quiet when a heartbeat repeats what the peer already said', () => {
    const { discovery, announce } = setup();

    announce('a', payload());

    const listener = vi.fn();

    discovery.peers.subscribe(listener);

    engine.tick = 100;
    announce('a', payload());
    engine.tick = 200;
    announce('a', payload());

    expect(listener).not.toHaveBeenCalled();
    // The refresh still landed — liveness moved without the list moving.
    expect(discovery.lastSeen('a')).toBe(200);
    // And the record was not rebuilt behind the list: one set of objects, not two equal ones.
    expect(discovery.getPeer('a')).toBe(discovery.peers.get()[0]);
  });

  it('republishes when a peer says something new, without reporting it up again', () => {
    const { discovery, announce } = setup();

    announce('a', payload());

    const listener = vi.fn();
    const up = vi.fn();

    discovery.peers.subscribe(listener);
    discovery.onPeerUp(up);

    announce('a', payload({ version: '2.0.0' }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(up).not.toHaveBeenCalled();
    expect(discovery.peers.get()[0]?.version).toBe('2.0.0');
  });

  it('republishes when a peer changes its meta', () => {
    const { discovery, announce } = setup();

    announce('a', payload({ meta: { displayName: 'Shop' } }));

    const listener = vi.fn();

    discovery.peers.subscribe(listener);

    announce('a', payload({ meta: { displayName: 'Shop' } }));
    expect(listener).not.toHaveBeenCalled();

    announce('a', payload({ meta: { displayName: 'Market' } }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('publishes once for a sweep that evicts several peers, before any listener runs', () => {
    const { discovery, announce, sweep } = setup();

    announce('a', payload());
    announce('b', payload());

    const listener = vi.fn();
    const duringDown: number[] = [];

    discovery.peers.subscribe(listener);
    discovery.onPeerDown(() => duringDown.push(discovery.peers.get().length));

    engine.tick = PEER_TTL_TICKS + 1;
    sweep();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(discovery.peers.get()).toEqual([]);
    // Both handlers saw the swept world, not a half-swept one.
    expect(duringDown).toEqual([0, 0]);
  });
});

describe('Discovery.incompatiblePeers', () => {
  it('publishes an unreachable node once and stays quiet on its heartbeats', () => {
    const { discovery, announce } = setup();
    const listener = vi.fn();

    discovery.incompatiblePeers.subscribe(listener);

    announce('old', payload({ pmin: PROTOCOL_MAX + 5, pmax: PROTOCOL_MAX + 9 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(discovery.incompatiblePeers.get().map(peer => peer.id)).toEqual(['old']);

    engine.tick = 100;
    announce('old', payload({ pmin: PROTOCOL_MAX + 5, pmax: PROTOCOL_MAX + 9 }));
    expect(listener).toHaveBeenCalledTimes(1);

    // It is not a peer either.
    expect(discovery.peers.get()).toEqual([]);
  });

  it('drops a node from the incompatible list once it announces a range this build can reach', () => {
    const { discovery, announce } = setup();

    announce('old', payload({ pmin: PROTOCOL_MAX + 5, pmax: PROTOCOL_MAX + 9 }));

    const listener = vi.fn();

    discovery.incompatiblePeers.subscribe(listener);

    announce('old', payload());

    expect(listener).toHaveBeenCalledTimes(1);
    expect(discovery.incompatiblePeers.get()).toEqual([]);
    expect(discovery.peers.get().map(peer => peer.id)).toEqual(['old']);
  });
});
