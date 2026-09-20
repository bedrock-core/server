/**
 * Events on the bus: a broadcast delivered once and kept by nobody. Two nodes share a fake bus
 * that delivers synchronously, so what the assertions see is what a realm sees in the same tick —
 * the sender hears its own event, a listener attached before the sender exists still fires, the
 * namespace comes from the envelope rather than the payload, and one listener that throws does
 * not stop the rest.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Bus, EnvelopeHandler, Unsubscribe } from '../src/bus';
import { MessageType, PROTOCOL_MAX } from '../src/constants';
import type { Envelope } from '../src/envelope';
import { Events } from '../src/events';

interface Wire {
  attach(id: string, handlers: Map<string, Set<EnvelopeHandler>>): void;
  deliver(from: string, type: string, data: unknown): void;
  /** Deliver as if some other node had sent it — the forged-sender case. */
  forge(src: string, type: string, data: unknown): void;
}

function wire(): Wire {
  const nodes = new Map<string, Map<string, Set<EnvelopeHandler>>>();

  const send = (src: string, skip: string | undefined, type: string, data: unknown): void => {
    const envelope: Envelope = { v: PROTOCOL_MAX, src, iid: `${src}-iid`, type, mid: `${src}/1`, data };

    for (const [id, handlers] of nodes) {
      if (id === skip) { continue; }

      for (const handler of handlers.get(type) ?? []) { handler(envelope); }
    }
  };

  return {
    attach: (id, handlers): void => { nodes.set(id, handlers); },
    deliver: (from, type, data): void => { send(from, from, type, data); },
    forge: (src, type, data): void => { send(src, undefined, type, data); },
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

function pair(): { w: Wire; a: Events; b: Events } {
  const w = wire();
  const a = new Events(fakeBus(w, 'a'), 'a');
  const b = new Events(fakeBus(w, 'b'), 'b');

  a.start();
  b.start();

  return { w, a, b };
}

describe('events', () => {
  it('reaches every listener in the same tick, the sender included', () => {
    const { a, b } = pair();
    const here: unknown[] = [];
    const there: unknown[] = [];

    a.on('a', 'purchase', payload => here.push(payload));
    b.on('a', 'purchase', payload => there.push(payload));

    a.emit('purchase', { gold: 5 });

    expect(here).toEqual([{ gold: 5 }]);
    expect(there).toEqual([{ gold: 5 }]);
  });

  it('names the sender from the envelope, so a listener hears only the namespace it asked for', () => {
    const { a, b } = pair();
    const fromA: string[] = [];
    const fromB: string[] = [];

    b.on('a', 'ping', (_payload, from) => fromA.push(from));
    b.on('b', 'ping', (_payload, from) => fromB.push(from));

    a.emit('ping');
    b.emit('ping');

    expect(fromA).toEqual(['a']);
    expect(fromB).toEqual(['b']);
  });

  it('keeps nothing: a listener attached after the fact hears nothing', () => {
    const { a, b } = pair();
    const seen: unknown[] = [];

    a.emit('purchase', { gold: 1 });
    b.on('a', 'purchase', payload => seen.push(payload));

    expect(seen).toEqual([]);

    a.emit('purchase', { gold: 2 });
    expect(seen).toEqual([{ gold: 2 }]);
  });

  it('lets a listener attach before the sender has ever emitted, and releases cleanly', () => {
    const { a, b } = pair();
    const seen: unknown[] = [];
    const release = b.on('nobody_yet', 'hello', payload => seen.push(payload));

    a.emit('hello', 1);
    expect(seen).toEqual([]);

    release();
    release();
    expect(seen).toEqual([]);
  });

  it('stops delivering once released, and once stopped', () => {
    const { a, b } = pair();
    const seen: unknown[] = [];
    const release = b.on('a', 'tick', payload => seen.push(payload));

    a.emit('tick', 1);
    release();
    a.emit('tick', 2);

    b.on('a', 'tick', payload => seen.push(payload));
    a.emit('tick', 3);

    b.stop();
    a.emit('tick', 4);

    expect(seen).toEqual([1, 3]);
  });

  it('isolates a listener that throws', () => {
    const { a } = pair();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: unknown[] = [];

    a.on('a', 'boom', () => { throw new Error('nope'); });
    a.on('a', 'boom', payload => seen.push(payload));

    expect(() => { a.emit('boom', 7); }).not.toThrow();
    expect(seen).toEqual([7]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a/boom'));

    warn.mockRestore();
  });

  it('ignores a message that is not an event payload', () => {
    const { w, b } = pair();
    const seen: unknown[] = [];

    b.on('a', 'purchase', payload => seen.push(payload));

    w.forge('a', MessageType.Event, 'not an object');
    w.forge('a', MessageType.Event, { name: 'purchase' });

    expect(seen).toEqual([]);
  });
});
