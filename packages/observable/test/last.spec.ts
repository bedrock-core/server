/**
 * `last` over both signal shapes: undefined before the first event, then each payload; an engine
 * signal whose subscribe returns the callback is released through unsubscribe, one whose subscribe
 * returns a function is released by calling it; subscribing is eager and dispose is what ends it.
 */
import { describe, expect, it } from 'vitest';
import { computed, last } from '../src/index';

interface Spawn { playerId: string }

/** The engine shape: subscribe returns the callback, unsubscribe takes it. */
function engineSignal<E>(): { signal: { subscribe(cb: (e: E) => void): (e: E) => void; unsubscribe(cb: (e: E) => void): void }; fire(e: E): void; listeners: number } {
  const set = new Set<(e: E) => void>();

  return {
    signal: {
      subscribe: (cb): ((e: E) => void) => {
        set.add(cb);

        return cb;
      },
      unsubscribe: (cb): void => { set.delete(cb); },
    },
    fire: (e): void => { for (const cb of set) { cb(e); } },
    get listeners(): number { return set.size; },
  };
}

/** The framework shape: subscribe returns a release function. */
function ourSignal<E>(): { signal: { subscribe(cb: (e: E) => void): () => void }; fire(e: E): void; listeners: number } {
  const set = new Set<(e: E) => void>();

  return {
    signal: { subscribe: (cb): (() => void) => {
      set.add(cb);

      return (): void => { set.delete(cb); };
    } },
    fire: (e): void => { for (const cb of set) { cb(e); } },
    get listeners(): number { return set.size; },
  };
}

describe('last', () => {
  it('is undefined until the first event, then the latest payload', () => {
    const { signal, fire } = engineSignal<Spawn>();
    const spawn = last(signal);
    const seen: (Spawn | undefined)[] = [];

    spawn.subscribe(next => seen.push(next));

    expect(spawn.get()).toBeUndefined();

    fire({ playerId: 'a' });
    fire({ playerId: 'b' });

    expect(spawn.get()).toEqual({ playerId: 'b' });
    expect(seen).toEqual([{ playerId: 'a' }, { playerId: 'b' }]);
  });

  it('subscribes eagerly, so nothing is missed before the first watcher', () => {
    const source = engineSignal<number>();
    const value = last(source.signal);

    expect(source.listeners).toBe(1);
    source.fire(1);
    expect(value.get()).toBe(1);
  });

  it('releases an engine signal through unsubscribe, and keeps the last value', () => {
    const source = engineSignal<number>();
    const value = last(source.signal);

    source.fire(3);
    value.dispose();
    value.dispose();

    expect(source.listeners).toBe(0);
    source.fire(4);
    expect(value.get()).toBe(3);
  });

  it('releases a framework signal by calling what subscribe returned', () => {
    const source = ourSignal<string>();
    const value = last(source.signal);

    source.fire('x');
    value.dispose();

    expect(source.listeners).toBe(0);
    expect(value.get()).toBe('x');
  });

  it('composes like any observable', () => {
    const { signal, fire } = engineSignal<Spawn>();
    const spawn = last(signal);
    const name = computed(() => spawn.get()?.playerId ?? 'nobody', [spawn]);

    expect(name.get()).toBe('nobody');
    fire({ playerId: 'steve' });
    expect(name.get()).toBe('steve');
  });

  it('forwards subscription options to the signal', () => {
    let received: unknown;
    const signal = {
      subscribe: (cb: (e: number) => void, options?: { blockTypes: string[] }): ((e: number) => void) => {
        received = options;

        return cb;
      },
      unsubscribe: (): void => {},
    };

    last(signal, { on: { blockTypes: ['papi:elevator'] } });

    expect(received).toEqual({ blockTypes: ['papi:elevator'] });
  });
});
