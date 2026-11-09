/**
 * Discovery as a value. The peer list is an observable, and the assertions here are about when it
 * republishes: a node arriving or leaving is news, a heartbeat that repeats what the peer already
 * said is not. That distinction is what lets a listener sit on `peers` without waking every five
 * seconds per peer, so it is the part worth pinning down. The engine is faked down to the three
 * members discovery uses — the tick, the interval, and cancelling one.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Bus, EnvelopeHandler, SendOptions, Unsubscribe } from '../src/bus';
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
interface DiscoveryBus {
  bus: Bus;
  announce: (src: string, data: unknown, instanceId?: string) => void;
  whois: (src: string) => void;
  send: Mock<(options: SendOptions) => string>;
  setPeerProtocol: Mock<(id: string, protocol: number, caps: readonly string[]) => void>;
  forgetPeer: Mock<(id: string) => void>;
}

function fakeBus(selfId: string): DiscoveryBus {
  const handlers = new Map<string, Set<EnvelopeHandler>>();
  const send = vi.fn<(options: SendOptions) => string>(() => 'mid');
  const setPeerProtocol = vi.fn<(id: string, protocol: number, caps: readonly string[]) => void>();
  const forgetPeer = vi.fn<(id: string) => void>();

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
    send,
    setPeerProtocol,
    forgetPeer,
  };

  const receive = (type: string, src: string, data: unknown, instanceId = src + '-iid'): void => {
    const envelope: Envelope = {
      v: PROTOCOL_MIN,
      src,
      iid: instanceId,
      type,
      mid: `${src}/1`,
      data,
    };

    for (const handler of handlers.get(type) ?? []) { handler(envelope); }
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return { bus: bus as unknown as Bus, announce: (src, data, instanceId): void => receive(MessageType.Announce, src, data, instanceId), whois: (src): void => receive(MessageType.Whois, src, undefined), send, setPeerProtocol, forgetPeer };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: '1.0.0', schemaVersion: 1, pmin: PROTOCOL_MIN, pmax: PROTOCOL_MAX, caps: SELF_CAPS, ...overrides };
}

function setup(): DiscoveryBus & {
  discovery: InstanceType<typeof Discovery>;
  sweep: () => void;
} {
  engine.tick = 0;
  engine.intervals = [];

  const double = fakeBus('self');
  const discovery = new Discovery(double.bus);

  discovery.start();

  const sweep = engine.intervals.find(entry => entry.period === 40);

  if (sweep === undefined) { throw new Error('discovery did not register its sweep'); }

  return { ...double, discovery, sweep: sweep.fn };
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
  it('retains announce metadata and republishes changes without repeating identical heartbeats', () => {
    const { discovery, announce } = setup();
    const listener = vi.fn();
    const range = { pmin: PROTOCOL_MAX + 5, pmax: PROTOCOL_MAX + 9 };

    discovery.incompatiblePeers.subscribe(listener);
    announce('core', payload({ ...range, meta: { runtimeVersion: '1.0.0' } }));

    expect(discovery.incompatiblePeers.get()[0]?.meta).toEqual({ runtimeVersion: '1.0.0' });
    announce('core', payload({ ...range, meta: { runtimeVersion: '1.0.0' } }));
    expect(listener).toHaveBeenCalledTimes(1);

    announce('core', payload({ ...range, meta: { runtimeVersion: '1.0.1' } }));
    expect(discovery.incompatiblePeers.get()[0]?.meta).toEqual({ runtimeVersion: '1.0.1' });
    expect(listener).toHaveBeenCalledTimes(2);

    announce('core', payload(range));
    expect(discovery.incompatiblePeers.get()[0]?.meta).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(3);
  });

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

  it('retires a compatible instance when its replacement announces an incompatible range', () => {
    const { discovery, announce, forgetPeer } = setup();
    const changed = vi.fn();
    const incompatible = vi.fn();
    const down = vi.fn(() => {
      expect(discovery.peers.get()).toEqual([]);
      expect(forgetPeer).toHaveBeenCalledExactlyOnceWith('peer');
    });

    announce('peer', payload(), 'peer/1');
    discovery.peers.subscribe(changed);
    discovery.onIncompatible(incompatible);
    discovery.onPeerDown(down);
    announce('peer', payload({ pmin: PROTOCOL_MAX + 1, pmax: PROTOCOL_MAX + 2 }), 'peer/2');

    expect(discovery.getPeer('peer')).toBeUndefined();
    expect(discovery.peers.get()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'peer', instanceId: 'peer/1' }));
    expect(incompatible).toHaveBeenCalledTimes(1);
    expect(discovery.incompatiblePeers.get()).toEqual([{ id: 'peer', pmin: PROTOCOL_MAX + 1, pmax: PROTOCOL_MAX + 2 }]);
    discovery.stop();
  });

  it('expires incompatible peers by heartbeat age without retiring fresh peers', () => {
    const { discovery, announce, sweep, forgetPeer } = setup();
    const range = { pmin: PROTOCOL_MAX + 1, pmax: PROTOCOL_MAX + 2 };

    announce('stale', payload(range));
    engine.tick = 10;
    announce('fresh', payload(range));
    const changed = vi.fn();

    discovery.incompatiblePeers.subscribe(changed);
    engine.tick = PEER_TTL_TICKS + 1;
    sweep();
    expect(discovery.incompatiblePeers.get().map(peer => peer.id)).toEqual(['fresh']);
    expect(discovery.lastSeen('stale')).toBeUndefined();
    expect(discovery.lastSeen('fresh')).toBe(10);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(forgetPeer).not.toHaveBeenCalled();
    sweep();
    expect(changed).toHaveBeenCalledTimes(1);
    discovery.stop();
  });
});

describe('discovery instance and event delivery', () => {
  it('ignores malformed announces and negotiates legacy peers without range fields', () => {
    const { discovery, announce, setPeerProtocol } = setup();

    for (const data of [null, 'announce', {}, { version: 1 }]) { announce('invalid', data); }

    expect(discovery.peers.get()).toEqual([]);
    expect(setPeerProtocol).not.toHaveBeenCalled();
    announce('legacy', { version: '1.0.0', schemaVersion: 'unknown', meta: null, pmin: '1', pmax: null, caps: [1, 'batch'] });
    expect(discovery.getPeer('legacy')).toMatchObject({ version: '1.0.0', schemaVersion: 0, protocol: PROTOCOL_MIN, caps: [] });
    expect(discovery.getPeer('legacy')?.meta).toBeUndefined();
    expect(setPeerProtocol).toHaveBeenCalledExactlyOnceWith('legacy', PROTOCOL_MIN, []);
    discovery.stop();
  });

  it('reports a same-id instance as a collision without negotiating it as a peer', () => {
    const { discovery, announce, setPeerProtocol } = setup();
    const collision = vi.fn();

    discovery.onCollision(collision);
    announce('self', payload(), 'other-instance');
    expect(collision).toHaveBeenCalledExactlyOnceWith({ id: 'self', instanceId: 'other-instance' });
    expect(discovery.peers.get()).toEqual([]);
    expect(discovery.incompatiblePeers.get()).toEqual([]);
    expect(setPeerProtocol).not.toHaveBeenCalled();
    discovery.stop();
  });

  it('publishes live metadata changes and answers whois only while subscribed', () => {
    const { bus, announce, whois, send } = fakeBus('self');
    const discovery = new Discovery(bus);

    discovery.updateMeta({ label: 'before start' });
    expect(send).not.toHaveBeenCalled();
    discovery.start();
    expect(send).toHaveBeenCalledWith({ type: MessageType.Announce, protocol: PROTOCOL_MIN, data: expect.objectContaining({ meta: { label: 'before start' } }) });
    expect(send).toHaveBeenCalledWith({ type: MessageType.Whois, protocol: PROTOCOL_MIN });
    send.mockClear();
    discovery.updateMeta({ label: 'live' });
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: MessageType.Announce, protocol: PROTOCOL_MIN, data: expect.objectContaining({ meta: { label: 'live' } }) });
    send.mockClear();
    whois('asker');
    expect(send).toHaveBeenCalledExactlyOnceWith({ dst: 'asker', type: MessageType.Announce, data: expect.objectContaining({ meta: { label: 'live' } }) });
    send.mockClear();
    discovery.stop();
    discovery.updateMeta({ label: 'after stop' });
    whois('asker');
    announce('late', payload());
    expect(send).not.toHaveBeenCalled();
    expect(discovery.peers.get()).toEqual([]);
  });

  it('publishes a changed running instance even with identical advertised metadata', () => {
    const { bus, announce } = fakeBus('self');
    const discovery = new Discovery(bus);
    const changed = vi.fn();

    discovery.start();
    discovery.peers.subscribe(changed);
    announce('peer', payload(), 'first');
    announce('peer', payload(), 'first');
    expect(changed).toHaveBeenCalledTimes(1);
    announce('peer', payload(), 'second');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(discovery.getPeer('peer')?.instanceId).toBe('second');
    discovery.stop();
  });

  it('isolates listeners while delivering a peer arrival', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { bus, announce } = fakeBus('self');
    const discovery = new Discovery(bus);
    const later = vi.fn();

    discovery.start();
    discovery.onPeerUp(() => { throw new Error('listener failed'); });
    discovery.onPeerUp(later);
    expect(() => announce('peer', payload())).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    discovery.stop();
    error.mockRestore();
  });
});
