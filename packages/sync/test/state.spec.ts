/**
 * The mirror's apply rule. Two nodes share a fake bus that delivers synchronously: the owner of a
 * namespace is the only writer a mirror trusts, an `open` key takes anyone's write, a foreign
 * write never opens a key, and snapshots carry the flag so a late joiner learns it.
 */
import { describe, expect, it } from 'vitest';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../src/bus';
import { PROTOCOL_MAX } from '../src/constants';
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

  it('takes anyone on a key the owner opened, and keeps it open', () => {
    const { a, b } = pair();

    a.set('a', 'votes', 0, { open: true });
    expect(b.isOpen('a', 'votes')).toBe(true);

    b.set('a', 'votes', 1);
    expect(a.get('a', 'votes')).toBe(1);
    expect(b.get('a', 'votes')).toBe(1);
    expect(a.isOpen('a', 'votes')).toBe(true);

    b.delete('a', 'votes');
    expect(a.get('a', 'votes')).toBeUndefined();
    expect(a.isOpen('a', 'votes')).toBe(true);
  });

  it('ignores open from a node that does not own the namespace', () => {
    const { a, b } = pair();

    a.set('a', 'price', 10);
    b.set('a', 'price', 5, { open: true });

    expect(a.get('a', 'price')).toBe(10);
    expect(a.isOpen('a', 'price')).toBe(false);
  });

  it('carries the flag in a snapshot, so a late joiner learns which keys are open', () => {
    const w = wire();
    const a = new State(fakeBus(w, 'a'), 'a');

    a.start();
    a.set('a', 'votes', 0, { open: true });
    a.set('a', 'price', 10);

    const late = new State(fakeBus(w, 'late'), 'late');

    late.start();

    expect(late.get('a', 'votes')).toBe(0);
    expect(late.isOpen('a', 'votes')).toBe(true);
    expect(late.isOpen('a', 'price')).toBe(false);

    late.set('a', 'votes', 3);
    late.set('a', 'price', 1);
    expect(a.get('a', 'votes')).toBe(3);
    expect(a.get('a', 'price')).toBe(10);
  });

  it('a snapshot relayed from a non-owner is refused for closed keys', () => {
    const w = wire();
    const a = new State(fakeBus(w, 'a'), 'a');
    const b = new State(fakeBus(w, 'b'), 'b', { ownedNamespaces: ['b', 'a'] });

    a.start();
    b.start();
    b.set('a', 'price', 1);

    expect(a.get('a', 'price')).toBeUndefined();
    expect(b.get('a', 'price')).toBe(1);
  });
});
