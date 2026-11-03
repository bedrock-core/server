import { batch } from '@bedrock-core/observable';
/**
 * The mirror's apply rule. Two nodes share a fake bus that delivers synchronously: the owner of a
 * namespace is the only writer a mirror trusts, whatever the key, and a late joiner gets the
 * owner's snapshot without inheriting a right to write it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../src/bus';
import { MessageType, PROTOCOL_MAX } from '../src/constants';
import type { Envelope } from '../src/envelope';
import { State } from '../src/state';

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

/** A `Bus` double with only the two members `State` uses; the class's private fields are not part of that contract. */
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

function pair(): { w: Wire; a: State; b: State } {
  const w = wire();
  const a = new State(fakeBus(w, 'a'), 'a');
  const b = new State(fakeBus(w, 'b'), 'b');

  a.start();
  b.start();

  return { w, a, b };
}

describe('owner-only apply', () => {
  it('mirrors the owner and drops a foreign write', () => {
    const { a, b } = pair();

    a.set('a', 'price', 10);
    expect(b.get('a', 'price')).toBe(10);

    b.set('a', 'price', 99);
    expect(a.get('a', 'price')).toBe(10);
    expect(b.get('a', 'price')).toBe(10);
    expect(a.droppedForeign).toBe(1);
    expect(b.droppedForeign).toBe(1);
  });

  it('drops a foreign write whatever the key, and counts every one', () => {
    const { a, b } = pair();

    a.set('a', 'votes', 0);
    b.set('a', 'votes', 1);
    b.set('a', 'anything', 2);

    expect(a.get('a', 'votes')).toBe(0);
    expect(a.get('a', 'anything')).toBeUndefined();
    expect(a.droppedForeign).toBe(2);
  });

  it('gives a late joiner the owner snapshot, and still refuses its writes', () => {
    const w = wire();
    const a = new State(fakeBus(w, 'a'), 'a');

    a.start();
    a.set('a', 'votes', 0);
    a.set('a', 'price', 10);

    const late = new State(fakeBus(w, 'late'), 'late');

    late.start();

    expect(late.get('a', 'votes')).toBe(0);
    expect(late.get('a', 'price')).toBe(10);

    late.set('a', 'votes', 3);
    expect(a.get('a', 'votes')).toBe(0);
  });

  it('refuses a snapshot relayed from a node that is not the namespace owner', () => {
    const w = wire();
    const a = new State(fakeBus(w, 'a'), 'a');

    a.start();
    w.deliver('b', undefined, MessageType.StateSnapshot, { ns: 'a', entries: [{ k: 'price', v: 1, ver: 1, src: 'b' }] });

    expect(a.get('a', 'price')).toBeUndefined();
    expect(a.droppedForeign).toBe(1);
  });
});

describe('observable mirror values', () => {
  it('invalidates a departed namespace and accepts a fresh lower version on its existing handle', () => {
    const { w, a, b } = pair();
    const value = b.observe<number>('a', 'value');
    const changed = vi.fn();

    value.subscribe(changed);
    a.set('a', 'value', 1);
    a.set('a', 'value', 2);
    b.forget('a');
    expect(value.get()).toBeUndefined();
    expect(b.snapshot('a')).toEqual([]);
    expect(b.namespaces()).toEqual([]);
    w.deliver('a', 'b', MessageType.StateDelta, { ns: 'a', key: 'value', value: 3, ver: 1 });
    expect(value.get()).toBe(3);
    expect(changed).toHaveBeenLastCalledWith(3, undefined);
  });

  it('keeps namespace and key publication order independent of observation order', () => {
    const { w, a, b } = pair();

    b.observe('other', 'pending');
    b.observe('a', 'later');
    a.set('a', 'first', 1);
    w.deliver('other', 'b', MessageType.StateDelta, { ns: 'other', key: 'pending', value: 3, ver: 1 });
    a.set('a', 'later', 2);
    expect(b.namespaces()).toEqual(['a', 'other']);
    expect(Object.keys(b.getNamespace('a'))).toEqual(['first', 'later']);
    expect(b.snapshot('a').map(entry => entry.k)).toEqual(['first', 'later']);
  });

  it('observes missing keys without publishing entries and receives a late-join snapshot', () => {
    const w = wire();
    const owner = new State(fakeBus(w, 'owner'), 'owner');
    const late = new State(fakeBus(w, 'late'), 'late');
    const value = late.observe<number>('owner', 'value');
    const changed = vi.fn();

    value.subscribe(changed);
    expect(value).not.toHaveProperty('set');
    expect(value.get()).toBeUndefined();
    expect(late.namespaces()).toEqual([]);
    expect(late.getNamespace('owner')).toEqual({});
    expect(late.snapshot('owner')).toEqual([]);
    owner.start();
    owner.set('owner', 'value', 7);
    late.start();
    expect(value.get()).toBe(7);
    expect(late.get('owner', 'value')).toBe(7);
    expect(late.getNamespace('owner')).toEqual({ value: 7 });
    expect(late.namespaces()).toEqual(['owner']);
    expect(changed).toHaveBeenCalledExactlyOnceWith(7, undefined);
  });

  it('reads committed values and versions during delivery and tracks equal-value writes', () => {
    const { a } = pair();

    a.set('a', 'value', 1);
    const value = a.observe<number>('a', 'value');
    const changes = vi.fn();
    const reads: unknown[] = [];

    value.subscribe((next, previous) => {
      reads.push({ next, previous, get: a.get('a', 'value'), namespace: a.getNamespace('a'), snapshot: a.snapshot('a') });
    });
    a.subscribe(changes);
    a.set('a', 'value', 2);
    expect(reads).toEqual([{
      next: 2, previous: 1, get: 2, namespace: { value: 2 }, snapshot: [{ k: 'value', v: 2, ver: 2, src: 'a', del: undefined }],
    }]);
    a.set('a', 'value', 2);
    expect(reads).toHaveLength(1);
    expect(a.snapshot('a')[0]).toMatchObject({ v: 2, ver: 3 });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('retains deletion versions separately from undefined and restores the same observed key', () => {
    const { w, a, b } = pair();
    const value = b.observe<number>('a', 'value');
    const changed = vi.fn();
    const applied = vi.fn();

    value.subscribe(changed);
    b.subscribe(applied);
    a.set('a', 'value', undefined);
    expect(Object.hasOwn(b.getNamespace('a'), 'value')).toBe(true);
    expect(b.snapshot('a')[0]).toMatchObject({ k: 'value', v: undefined, ver: 1 });
    a.delete('a', 'value');
    expect(b.getNamespace('a')).toEqual({});
    expect(b.snapshot('a')[0]).toMatchObject({ k: 'value', v: undefined, ver: 2, del: true });
    expect(applied).toHaveBeenLastCalledWith({ ns: 'a', key: 'value', value: undefined, deleted: true });
    w.deliver('a', 'b', MessageType.StateSnapshot, { ns: 'a', entries: [{ k: 'value', v: 9, ver: 1, src: 'a' }] });
    expect(value.get()).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    a.set('a', 'value', 3);
    expect(value.get()).toBe(3);
    expect(b.get('a', 'value')).toBe(3);
    expect(changed).toHaveBeenCalledExactlyOnceWith(3, undefined);
    expect(b.snapshot('a')[0]).toMatchObject({ v: 3, ver: 3 });
  });

  it('applies remote observable updates without echoing them or accepting stale and foreign writes', () => {
    const w = wire();
    const bus = fakeBus(w, 'reader');
    const reader = new State(bus, 'reader');
    const value = reader.observe<number>('owner', 'value');
    const changed = vi.fn();

    reader.start();
    const send = vi.spyOn(bus, 'send');

    value.subscribe(changed);
    w.deliver('owner', 'reader', MessageType.StateDelta, { ns: 'owner', key: 'value', value: 4, ver: 5 });
    w.deliver('owner', 'reader', MessageType.StateDelta, { ns: 'owner', key: 'value', value: 1, ver: 4 });
    w.deliver('foreign', 'reader', MessageType.StateDelta, { ns: 'owner', key: 'value', value: 9, ver: 6 });
    expect(value.get()).toBe(4);
    expect(changed).toHaveBeenCalledExactlyOnceWith(4, undefined);
    expect(reader.snapshot('owner')[0]).toMatchObject({ v: 4, ver: 5, src: 'owner' });
    expect(reader.droppedForeign).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('updates only the observed key and uses standard batched notifications', () => {
    const { a, b } = pair();
    const value = b.observe<number>('a', 'value');
    const listener = vi.fn();

    value.subscribe(listener);
    a.set('a', 'unrelated', 1);
    expect(listener).not.toHaveBeenCalled();
    batch(() => {
      a.set('a', 'value', 1);
      a.set('a', 'value', 2);
    });
    expect(value.get()).toBe(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(2, undefined);
    a.set('a', 'value', 2);
    expect(listener).toHaveBeenCalledTimes(1);
    a.delete('a', 'value');
    expect(value.get()).toBeUndefined();
    expect(listener).toHaveBeenLastCalledWith(undefined, 2);
  });

  it('isolates state change listeners so other listeners and remote mirrors receive writes', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { a, b } = pair();
    const later = vi.fn();

    a.subscribe(() => { throw new Error('listener failed'); });
    a.subscribe(later);
    expect(() => a.set('a', 'value', 3)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(b.get('a', 'value')).toBe(3);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
