import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '../src/envelope';
import { encodeEnvelope } from '../src/envelope';
import { BUS_CHANNEL, MessageType, PEER_TTL_TICKS, PROTOCOL_MAX, PROTOCOL_MIN } from '../src/constants';
import { decodeWire, encodeBatch, encodeLegacy } from '../src/wire';

const engine = vi.hoisted(() => ({
  tick: 0,
  next: 0,
  tasks: new Map<number, { at: number; repeat: number; run: () => void }>(),
  listeners: new Set<(event: { id: string; message: string }) => void>(),
  messages: [] as string[],
}));

function schedule(run: () => void, delay = 1, repeat = 0): number {
  const id = ++engine.next;

  engine.tasks.set(id, { at: engine.tick + Math.max(1, delay), repeat, run });

  return id;
}

vi.mock('@minecraft/server', () => ({
  system: {
    get currentTick(): number { return engine.tick; },
    run: (run: () => void): number => schedule(run),
    runTimeout: (run: () => void, delay: number): number => schedule(run, delay),
    runInterval: (run: () => void, period: number): number => schedule(run, period, period),
    clearRun: (id: number): void => { engine.tasks.delete(id); },
    sendScriptEvent: (id: string, message: string): void => {
      engine.messages.push(message);

      for (const listener of [...engine.listeners]) { listener({ id, message }); }
    },
    afterEvents: {
      scriptEventReceive: {
        subscribe: (listener: (event: { id: string; message: string }) => void): typeof listener => {
          engine.listeners.add(listener);

          return listener;
        },
        unsubscribe: (listener: (event: { id: string; message: string }) => void): void => { engine.listeners.delete(listener); },
      },
    },
  },
}));

const { Replication, SyncNode } = await import('../src/index');
const nodes: InstanceType<typeof SyncNode>[] = [];

function node(id: string): InstanceType<typeof SyncNode> {
  const value = new SyncNode({ id });

  nodes.push(value);
  value.start();

  return value;
}

async function ticks(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) {
    engine.tick++;

    for (const [id, task] of [...engine.tasks]) {
      if (task.at > engine.tick || engine.tasks.get(id) !== task) { continue; }

      if (task.repeat > 0) { task.at += task.repeat; } else { engine.tasks.delete(id); }

      task.run();
    }

    await Promise.resolve();
  }
}

function replicas(): Envelope[] {
  return engine.messages.flatMap((message) => {
    const wire = decodeWire(message);

    return wire?.kind === 'envelopes' ? wire.envelopes : [];
  }).filter(envelope => envelope.type === MessageType.Replica);
}

function dataOf(envelope: Envelope): Record<string, unknown> {
  if (typeof envelope.data !== 'object' || envelope.data === null || Array.isArray(envelope.data)) {
    throw new Error('expected replica message data');
  }

  return Object.fromEntries(Object.entries(envelope.data));
}

function inject(envelope: Envelope): void {
  const message = encodeBatch([encodeEnvelope({ ...envelope, mid: `replayed/${++engine.next}` })]);

  for (const listener of [...engine.listeners]) { listener({ id: BUS_CHANNEL, message }); }
}

beforeEach(() => {
  engine.tick = 0;
  engine.next = 0;
  engine.tasks.clear();
  engine.listeners.clear();
  engine.messages = [];
});

afterEach(() => {
  for (const value of nodes.splice(0)) { value.stop(); }
});

describe('SyncNode.replication', () => {
  it('shares watches, requests once and releases retained values after the last handle stops', async () => {
    const owner = node('owner');
    const reader = node('reader');
    const publication = owner.replication.publish('fixture', { label: 'initial' });

    expect(owner.replication).toBeInstanceOf(Replication);
    await ticks();
    engine.messages = [];
    const first = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');
    const second = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    expect(first.snapshot).toBe(second.snapshot);
    expect(first.snapshot.get().status).toBe('loading');
    await ticks();
    expect(second.snapshot.get().value).toEqual({ label: 'initial' });
    expect(replicas().filter(envelope => dataOf(envelope).op === 'request')).toHaveLength(1);
    first.stop();
    publication.set({ label: 'updated' });
    await ticks();
    expect(second.snapshot.get().value).toEqual({ label: 'updated' });
    engine.messages = [];
    await ticks(180);
    expect(replicas()).toEqual([]);
    second.stop();
    second.stop();
    expect(second.snapshot.get().status).toBe('stopped');
    publication.set({ label: 'broadcast without readers' });
    await ticks();
    expect(replicas()).toHaveLength(1);
    expect(second.snapshot.get()).toEqual({ status: 'stopped', generation: -1, revision: -1 });
  });

  it('broadcasts one replacement to multiple readers and guards copied structured values', async () => {
    const owner = node('owner');
    const left = node('left');
    const right = node('right');
    const source = new Map([['items', new Set(['stone'])]]);
    const publication = owner.replication.publish('fixture', source);

    source.get('items')?.add('authored later');
    await ticks();
    const a = left.replication.watch(owner.id, owner.bus.instanceId, 'fixture');
    const b = right.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    const value = a.snapshot.get().value;

    expect(value).toBeInstanceOf(Map);

    if (!(value instanceof Map)) { throw new Error('expected a map snapshot'); }

    expect(value.get('items')).toEqual(new Set(['stone']));
    expect(() => value.set('other', new Set())).toThrow('read-only');
    engine.messages = [];
    publication.set({ amount: BigInt('9007199254740993'), optional: undefined });
    await ticks();
    expect(replicas()).toHaveLength(1);
    expect(replicas()[0].dst).toBeUndefined();
    expect(a.snapshot.get().value).toEqual({ amount: BigInt('9007199254740993'), optional: undefined });
    expect(b.snapshot.get().value).toEqual(a.snapshot.get().value);
  });

  it('distinguishes missing publications, present undefined values, withdrawals and replacements', async () => {
    const owner = node('owner');
    const reader = node('reader');

    await ticks();
    const watch = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    expect(watch.snapshot.get()).toEqual({ status: 'missing', generation: 0, revision: 0 });
    const publication = owner.replication.publish('fixture', undefined);

    expect(() => owner.replication.publish('fixture', 1)).toThrow('already published');
    await ticks();
    expect(watch.snapshot.get()).toMatchObject({ status: 'ready', value: undefined });
    expect(Object.hasOwn(watch.snapshot.get(), 'value')).toBe(true);
    publication.stop();
    publication.stop();
    await ticks();
    expect(watch.snapshot.get().status).toBe('missing');
    expect(Object.hasOwn(watch.snapshot.get(), 'value')).toBe(false);
    expect(() => publication.set('stale')).toThrow('stopped');
    owner.replication.publish('fixture', 'replacement');
    await ticks();
    expect(watch.snapshot.get()).toMatchObject({ status: 'ready', value: 'replacement' });
  });

  it('fences publication generations and retained handles across consumer restarts', async () => {
    const owner = node('owner');
    const reader = node('reader');
    const initial = owner.replication.publish('fixture', { label: 'initial' });

    await ticks();
    const old = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    expect(old.snapshot.get().value).toEqual({ label: 'initial' });
    const delayed = replicas().find(envelope => envelope.src === owner.id && dataOf(envelope).op === 'snapshot');

    if (!delayed) { throw new Error('snapshot did not arrive'); }

    initial.stop();
    const next = owner.replication.publish('fixture', { label: 'replacement' });

    await ticks();
    inject(delayed);
    expect(old.snapshot.get().value).toEqual({ label: 'replacement' });
    reader.stop();
    reader.start();
    const current = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    old.stop();
    await ticks();
    expect(current.snapshot.get().value).toEqual({ label: 'replacement' });
    next.set({ label: 'current' });
    await ticks();
    expect(current.snapshot.get().value).toEqual({ label: 'current' });
  });

  it('rejects replies for a released watch token or a different reader instance', async () => {
    const owner = node('owner');
    const reader = node('reader');

    owner.replication.publish('fixture', 'initial');
    await ticks();
    const old = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    const delayed = replicas().find(envelope => envelope.dst === reader.id && dataOf(envelope).op === 'snapshot');

    if (!delayed) { throw new Error('directed snapshot did not arrive'); }

    old.stop();
    const current = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    inject({ ...delayed, data: { ...dataOf(delayed), generation: 999, value: 'stale token' } });
    expect(current.snapshot.get().status).toBe('loading');
    await ticks();
    expect(current.snapshot.get().value).toBe('initial');
    const reply = replicas().filter(envelope => envelope.dst === reader.id && dataOf(envelope).op === 'snapshot').at(-1);

    if (!reply) { throw new Error('current snapshot did not arrive'); }

    inject({ ...reply, data: { ...dataOf(reply), generation: 999, target: 'other-reader-instance', value: 'wrong target' } });
    expect(current.snapshot.get().value).toBe('initial');
  });

  it('invalidates departed instances through discovery and accepts a replacement with fresh versions', async () => {
    const owner = node('owner');
    const reader = node('reader');
    const publication = owner.replication.publish('fixture', 'first');

    await ticks();
    const old = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    publication.set('latest');
    await ticks();
    const delayed = replicas().find(envelope => envelope.src === owner.id && dataOf(envelope).op === 'snapshot');

    if (!delayed) { throw new Error('snapshot did not arrive'); }

    owner.stop();
    const replacement = node('owner');

    replacement.replication.publish('fixture', 'new instance');
    await ticks();
    expect(old.snapshot.get().status).toBe('unavailable');
    expect(Object.hasOwn(old.snapshot.get(), 'value')).toBe(false);
    const current = reader.replication.watch(replacement.id, replacement.bus.instanceId, 'fixture');

    await ticks();
    expect(current.snapshot.get().value).toBe('new instance');
    inject({ ...delayed, data: { ...dataOf(delayed), generation: 999, revision: 999, value: 'old instance' } });
    expect(current.snapshot.get().value).toBe('new instance');
    expect(old.snapshot.get().status).toBe('unavailable');
  });

  it('invalidates expired peers and stops all publication and watch handles with the node', async () => {
    const owner = node('owner');
    const reader = node('reader');
    const publication = owner.replication.publish('fixture', 'available');

    await ticks();
    const watch = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    owner.stop();
    expect(() => publication.set('after shutdown')).toThrow('stopped');
    await ticks(PEER_TTL_TICKS + 40);
    expect(watch.snapshot.get().status).toBe('unavailable');
    reader.stop();
    expect(watch.snapshot.get().status).toBe('stopped');
    expect(() => reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture')).toThrow('not started');
    expect(engine.listeners.size).toBe(0);
    expect(engine.tasks.size).toBe(0);
  });

  it('invalidates instance ownership when a replacement announces an incompatible protocol', async () => {
    const owner = node('owner');
    const reader = node('reader');

    owner.state.set(owner.id, 'title', 'initial');
    owner.replication.publish('fixture', 'available');
    await ticks();
    const watch = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    expect(reader.state.get(owner.id, 'title')).toBe('initial');
    expect(watch.snapshot.get().value).toBe('available');
    expect(reader.bus.broadcastProtocol).toBe(PROTOCOL_MAX);
    owner.stop();
    const taskCount = engine.tasks.size;
    const rejected = expect(reader.rpc.request(owner.id, 'read', undefined, { instanceId: owner.bus.instanceId })).rejects.toThrow(/owner.*stopped/);

    expect(engine.tasks.size).toBe(taskCount + 1);
    const announcement: Envelope = {
      v: PROTOCOL_MIN, src: owner.id, iid: 'future-instance', mid: 'future/announce', type: MessageType.Announce,
      data: { version: 'future', pmin: PROTOCOL_MAX + 1, pmax: PROTOCOL_MAX + 2 },
    };

    for (const message of encodeLegacy(encodeEnvelope(announcement), announcement.mid, 2000)) {
      for (const listener of [...engine.listeners]) { listener({ id: BUS_CHANNEL, message }); }
    }

    await rejected;
    expect(reader.discovery.getPeer(owner.id)).toBeUndefined();
    expect(reader.discovery.incompatiblePeers.get()).toEqual([{ id: owner.id, pmin: PROTOCOL_MAX + 1, pmax: PROTOCOL_MAX + 2 }]);
    expect(reader.bus.broadcastProtocol).toBe(PROTOCOL_MIN);
    expect(engine.tasks.size).toBe(taskCount);
    expect(reader.state.get(owner.id, 'title')).toBeUndefined();
    expect(watch.snapshot.get().status).toBe('unavailable');
    inject({
      v: PROTOCOL_MAX, src: owner.id, iid: owner.bus.instanceId, mid: 'old/update', type: MessageType.StateDelta,
      data: { ns: owner.id, key: 'title', value: 'stale', ver: 999 },
    });
    expect(reader.state.get(owner.id, 'title')).toBeUndefined();
  });

  it('ignores stale revisions and malformed snapshot metadata', async () => {
    const owner = node('owner');
    const reader = node('reader');
    const publication = owner.replication.publish('fixture', 'first');

    await ticks();
    const watch = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture');

    await ticks();
    const delayed = replicas().find(envelope => envelope.src === owner.id && dataOf(envelope).op === 'snapshot');

    if (!delayed) { throw new Error('snapshot did not arrive'); }

    publication.set('latest');
    await ticks();
    inject(delayed);

    for (const invalid of [{ generation: -1 }, { revision: -1 }, { generation: 1.5 }, { present: 'yes' }, { op: 'unknown' }]) {
      inject({ ...delayed, data: { ...dataOf(delayed), generation: 999, revision: 999, value: 'invalid', ...invalid } });
    }

    expect(watch.snapshot.get().value).toBe('latest');
  });
});
