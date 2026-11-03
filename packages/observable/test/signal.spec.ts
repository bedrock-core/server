import { describe, expect, it, vi } from 'vitest';
import { last, signal, toSignal, type Signal, type NativeSignal } from '../src/index';

describe('signal', () => {
  it('keeps the factory subscribe-only with a directly callable cleanup', () => {
    const source = signal<number>();
    const callback = vi.fn();
    const stop = source.subscribe(callback);

    expect(source).not.toHaveProperty('unsubscribe');
    stop();
    source.emit(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('normalizes explicit subscriptions with independently owned callbacks', () => {
    const callbacks = new Set<(value: number) => void>();
    const source: NativeSignal<number> = {
      subscribe(callback) {
        callbacks.add(callback);

        return callback;
      },
      unsubscribe(callback) { callbacks.delete(callback); },
    };
    const callback = vi.fn();
    const first = toSignal(source).subscribe(callback);
    const second = toSignal(source).subscribe(callback);

    expect(callbacks.size).toBe(2);
    first();
    first();

    for (const listener of callbacks) { listener(3); }

    expect(callback).toHaveBeenCalledExactlyOnceWith(3);
    second();
    expect(callbacks.size).toBe(0);
  });

  it('removes callback/void sources explicitly without invoking a returned callback', () => {
    for (const returnsCallback of [true, false]) {
      const callback = vi.fn();
      const removal = vi.fn();
      const source: NativeSignal<number> = {
        subscribe: listener => returnsCallback ? (value: number): void => listener(value) : undefined,
        unsubscribe: removal,
      };
      const stop = toSignal(source).subscribe(callback);

      stop();
      stop();
      expect(callback).not.toHaveBeenCalled();
      expect(removal).toHaveBeenCalledTimes(1);
    }
  });

  it('converts lazily, forwards options and removes the returned native callback', () => {
    let registered = (_value: number): void => {};

    const removal = vi.fn();
    const add = vi.fn((callback: (value: number) => void, _options?: { kind: string }): ((value: number) => void) => {
      registered = (value): void => { callback(value); };

      return registered;
    });
    const native: NativeSignal<number, { kind: string }> = { subscribe: add, unsubscribe: removal };
    const events = toSignal(native, { kind: 'drop' });
    const callback = vi.fn();

    expect(add).not.toHaveBeenCalled();
    expect(events).not.toHaveProperty('unsubscribe');
    expect(events).not.toHaveProperty('get');
    const stop = events.subscribe(callback);

    expect(add.mock.calls[0][1]).toEqual({ kind: 'drop' });
    registered(4);
    expect(callback).toHaveBeenCalledExactlyOnceWith(4);
    stop();
    stop();
    expect(removal).toHaveBeenCalledExactlyOnceWith(registered);
  });

  it('allows cleanup to be retried when native removal throws', () => {
    const removal = vi.fn().mockImplementationOnce(() => { throw new Error('restricted phase'); });
    const source: NativeSignal<number> = { subscribe: callback => callback, unsubscribe: removal };
    const stop = toSignal(source).subscribe(() => undefined);

    expect(stop).toThrow('restricted phase');
    stop();
    stop();
    expect(removal).toHaveBeenCalledTimes(2);
  });

  it('has no replay and delivers repeated and undefined payloads independently', () => {
    const source = signal<number | undefined>();
    const seen: (number | undefined)[] = [];

    source.emit(1);
    source.subscribe(value => seen.push(value));
    expect(seen).toEqual([]);
    source.emit(2);
    source.emit(2);
    source.emit(undefined);
    source.emit(undefined);
    expect(seen).toEqual([2, 2, undefined, undefined]);
    expect(source).not.toHaveProperty('get');
  });

  it('releases each subscription independently and idempotently', () => {
    const source = signal<string>();
    const listener = vi.fn();
    const first = source.subscribe(listener);
    const second = source.subscribe(listener);

    source.emit('a');
    expect(listener).toHaveBeenCalledTimes(2);
    first();
    first();
    source.emit('b');
    expect(listener).toHaveBeenCalledTimes(3);
    second();
    source.emit('c');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('isolates a failing listener so other listeners still receive the event', () => {
    const error = new Error('listener failed');
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = signal<void>();
    const listener = vi.fn();

    source.subscribe(() => { throw error; });
    source.subscribe(listener);
    expect(() => source.emit()).not.toThrow();
    expect(listener).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(report).toHaveBeenCalledWith('[observable] signal: listener threw', error);
    report.mockRestore();
  });

  it('composes with last through the standard readonly Signal contract', () => {
    const producer = signal<{ value: number }>();
    const events: Signal<{ value: number }> = producer;
    const latest = last(events);

    expect(latest.get()).toBeUndefined();
    producer.emit({ value: 3 });
    expect(latest.get()).toEqual({ value: 3 });
    latest.dispose();
    producer.emit({ value: 4 });
    expect(latest.get()).toEqual({ value: 3 });
  });
});
