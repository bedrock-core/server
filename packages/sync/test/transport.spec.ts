import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusOptions } from '../src/bus';
import type { OutboundQueueOptions } from '../src/queue';
import { Reassembler } from '../src/chunk';
import { BUS_CHANNEL, Cap, PROTOCOL_MAX, PROTOCOL_MIN, WireTag } from '../src/constants';
import { decodeEnvelope, encodeEnvelope, type Envelope } from '../src/envelope';
import { batchLength, decodeWire, encodeBatch } from '../src/wire';

const engine = vi.hoisted(() => ({
  tick: 0,
  next: 0,
  intervals: new Map<number, { run: () => void; period: number }>(),
  runs: [] as (() => void)[],
  listeners: new Set<(event: { id: string; message: string }) => void>(),
  sent: [] as { id: string; message: string }[],
  limit: Infinity,
}));

vi.mock('@minecraft/server', () => ({ system: {
  get currentTick(): number { return engine.tick; },
  run: (run: () => void): number => {
    engine.runs.push(run);

    return ++engine.next;
  },
  runInterval: (run: () => void, period: number): number => {
    const id = ++engine.next;

    engine.intervals.set(id, { run, period });

    return id;
  },
  clearRun: (id: number): void => { engine.intervals.delete(id); },
  sendScriptEvent: (id: string, message: string): void => {
    if (message.length > engine.limit) { throw new Error('message exceeds engine limit'); }

    engine.sent.push({ id, message });
  },
  afterEvents: { scriptEventReceive: {
    subscribe: (listener: (event: { id: string; message: string }) => void): typeof listener => {
      engine.listeners.add(listener);

      return listener;
    },
    unsubscribe: (listener: (event: { id: string; message: string }) => void): void => { engine.listeners.delete(listener); },
  } },
} }));

const { Bus } = await import('../src/bus');
const { OutboundQueue } = await import('../src/queue');
const running: { stop: () => void }[] = [];

function queue(options: Partial<OutboundQueueOptions> = {}): InstanceType<typeof OutboundQueue> {
  const value = new OutboundQueue({ channel: BUS_CHANNEL, ...options });

  running.push(value);

  return value;
}

function bus(options: BusOptions = {}): InstanceType<typeof Bus> {
  const value = new Bus('local', { instanceId: 'local/1', ...options });

  running.push(value);
  value.start();

  return value;
}

function tick(): void {
  engine.tick++;

  for (const run of engine.runs.splice(0)) { run(); }

  for (const interval of [...engine.intervals.values()]) {
    if (engine.tick % interval.period === 0) { interval.run(); }
  }
}

function envelope(mid: string, data: unknown = mid): Envelope {
  return { v: PROTOCOL_MAX, src: 'remote', iid: 'remote/1', type: 'data', mid, data };
}

function inject(value: Envelope, channel = BUS_CHANNEL): void {
  const event = { id: channel, message: encodeBatch([encodeEnvelope(value)]) };

  for (const listener of [...engine.listeners]) { listener(event); }
}

function delivered(): Envelope[] {
  const reassembler = new Reassembler();

  return engine.sent.flatMap(({ message }) => {
    const wire = decodeWire(message);

    if (wire?.kind === 'envelopes') { return wire.envelopes; }

    if (wire?.kind !== 'chunk') { throw new Error('invalid outgoing message'); }

    const payload = reassembler.accept(wire.frame, engine.tick);

    if (payload === undefined) { return []; }

    const value = decodeEnvelope(payload);

    if (value === undefined) { throw new Error('invalid outgoing envelope'); }

    return [value];
  });
}

beforeEach(() => {
  engine.tick = 0;
  engine.next = 0;
  engine.sent = [];
  engine.limit = Infinity;
});

afterEach(() => {
  for (const value of running.splice(0)) { value.stop(); }

  expect(engine.intervals.size).toBe(0);
  expect(engine.listeners.size).toBe(0);
  expect(engine.runs).toHaveLength(0);
});

describe('outbound backpressure', () => {
  it('bounds each flush and retains ordered work across stop and restart', () => {
    const value = queue({ maxFlushPerTick: 2 });

    for (const message of ['first', 'second', 'third']) { value.enqueueStandalone(message); }

    value.start();
    value.start();
    expect(engine.intervals.size).toBe(1);
    tick();
    expect(engine.sent.map(item => item.message)).toEqual(['first', 'second']);
    expect(value.size).toBe(1);
    value.stop();
    tick();
    expect(value.size).toBe(1);
    value.enqueueStandalone('fourth');
    value.start();
    tick();
    expect(engine.sent.map(item => item.message)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(value.size).toBe(0);
  });

  it('fills the exact batch budget and flushes before a standalone message', () => {
    const entries = ['a', 'b', 'c', 'd'].map(mid => encodeEnvelope(envelope(mid)));
    const cap = batchLength([entries[0].length, entries[1].length]);
    const value = queue({ maxMessage: cap });

    for (const entry of entries.slice(0, 3)) { value.enqueueEnvelope(entry); }

    value.enqueueStandalone('standalone');
    value.enqueueEnvelope(entries[3]);
    value.start();
    tick();
    expect(engine.sent[0].message).toHaveLength(cap);
    expect(engine.sent.map(({ message }) => {
      const wire = decodeWire(message);

      return wire?.kind === 'envelopes' ? wire.envelopes.map(item => item.mid) : message;
    })).toEqual([['a', 'b'], ['c'], 'standalone', ['d']]);
    expect(value.size).toBe(0);
  });

  it('counts a rejected oversized message toward the flush budget and continues draining', () => {
    const value = queue({ maxMessage: 150, maxFlushPerTick: 2 });

    engine.limit = 150;
    value.enqueueEnvelope(encodeEnvelope(envelope('oversized', 'x'.repeat(1000))));
    value.enqueueEnvelope(encodeEnvelope(envelope('valid')));
    value.enqueueStandalone('tail');
    value.start();
    expect(() => tick()).not.toThrow();
    expect(value.dropped).toBe(1);
    expect(delivered().map(item => item.mid)).toEqual(['valid']);
    expect(value.size).toBe(1);
    tick();
    expect(engine.sent.at(-1)?.message).toBe('tail');
    expect(value.size).toBe(0);
    expect(value.dropped).toBe(1);
  });
});

describe('Bus negotiation and routing', () => {
  it('uses legacy framing for unknown peers and returns to it after the last peer leaves', () => {
    const value = bus();

    value.send({ dst: 'unknown', type: 'data', data: 'initial' });
    tick();
    expect(engine.sent[0].message[0]).toBe('{');
    expect(delivered()[0]).toMatchObject({ v: PROTOCOL_MIN, dst: 'unknown', data: 'initial' });
    value.setPeerProtocol('modern', PROTOCOL_MAX, [Cap.Batch]);
    expect(value.broadcastProtocol).toBe(PROTOCOL_MAX);
    value.setPeerProtocol('legacy', PROTOCOL_MIN, []);
    expect(value.broadcastProtocol).toBe(PROTOCOL_MIN);
    value.send({ type: 'data', data: 'mixed world' });
    tick();
    expect(delivered().at(-1)).toMatchObject({ v: PROTOCOL_MIN, data: 'mixed world' });
    value.forgetPeer('legacy');
    expect(value.broadcastProtocol).toBe(PROTOCOL_MAX);
    value.send({ type: 'data', data: 'modern world' });
    tick();
    expect(delivered().at(-1)).toMatchObject({ v: PROTOCOL_MAX, data: 'modern world' });
    value.forgetPeer('modern');
    expect(value.broadcastProtocol).toBe(PROTOCOL_MIN);
    value.send({ type: 'data', data: 'empty world' });
    tick();
    expect(engine.sent.at(-1)?.message[0]).toBe('{');
    expect(delivered().at(-1)).toMatchObject({ v: PROTOCOL_MIN, data: 'empty world' });
  });

  it('disables packing while any live peer lacks batching and restores it on departure', () => {
    const value = bus();

    value.setPeerProtocol('modern', PROTOCOL_MAX, [Cap.Batch]);
    value.setPeerProtocol('no-batch', PROTOCOL_MAX, []);
    value.send({ dst: 'modern', type: 'data', data: 1 });
    value.send({ dst: 'modern', type: 'data', data: 2 });
    tick();
    expect(engine.sent.map(item => item.message[0])).toEqual([WireTag.Envelope, WireTag.Envelope]);
    value.forgetPeer('no-batch');
    engine.sent = [];
    value.send({ dst: 'modern', type: 'data', data: 3 });
    value.send({ dst: 'modern', type: 'data', data: 4 });
    tick();
    expect(engine.sent).toHaveLength(1);
    expect(engine.sent[0].message[0]).toBe(WireTag.Batch);
    expect(delivered().map(item => item.data)).toEqual([3, 4]);
  });

  it('delivers self-addressed structured data asynchronously as a separate snapshot', () => {
    const value = bus();
    const receive = vi.fn();
    const source = new Map([['items', new Set(['stone'])]]);

    value.on('data', receive);
    const mid = value.send({ dst: 'local', type: 'data', data: { left: source, right: source } });

    source.get('items')?.add('later');
    expect(receive).not.toHaveBeenCalled();
    expect(value.queueSize).toBe(0);
    tick();
    expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      v: PROTOCOL_MAX, mid, data: { left: new Map([['items', new Set(['stone'])]]), right: new Map([['items', new Set(['stone'])]]) },
    }));
    const data: unknown = receive.mock.calls[0][0].data;

    if (typeof data !== 'object' || data === null || !('left' in data && 'right' in data)) { throw new Error('missing loopback data'); }

    expect(data.left).toBe(data.right);
    expect(data.left).not.toBe(source);
    expect(engine.sent).toEqual([]);
  });

  it('filters echoes, other destinations and rejected senders while retaining same-addon twins', () => {
    const accept = vi.fn((value: Envelope) => value.data !== 'blocked');
    const value = bus({ accept });
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = value.on('data', first);
    const offSecond = value.on('data', second);

    value.start();
    expect(engine.listeners.size).toBe(1);
    expect(engine.intervals.size).toBe(2);
    inject({ ...envelope('echo'), iid: value.instanceId });
    inject({ ...envelope('foreign'), dst: 'elsewhere' });
    inject(envelope('policy', 'blocked'));
    inject(envelope('channel'), 'other:channel');

    for (const listener of engine.listeners) { listener({ id: BUS_CHANNEL, message: 'invalid' }); }

    expect(first).not.toHaveBeenCalled();
    const twin = { ...envelope('twin'), src: 'local', iid: 'local/2', dst: 'local' };

    inject(twin);
    expect(first).toHaveBeenCalledExactlyOnceWith(twin);
    expect(second).toHaveBeenCalledExactlyOnceWith(twin);
    offFirst();
    inject(envelope('next'));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
    inject(envelope('unsubscribed'));
    expect(second).toHaveBeenCalledTimes(2);
  });
});
