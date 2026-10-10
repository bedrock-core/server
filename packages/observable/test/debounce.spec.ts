import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batch, computed, debounce, effect, observable, type DebounceScheduler } from '../src/index';

const schedule: DebounceScheduler = (callback) => {
  const timer = setTimeout(callback, 100);

  return (): void => clearTimeout(timer);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('debounce', () => {
  it('starts with the current value without scheduling an initial notification', () => {
    const scheduler = vi.fn(schedule);
    const value = debounce(observable(7), scheduler);

    expect(value.get()).toBe(7);
    expect(scheduler).not.toHaveBeenCalled();
    expect('set' in value).toBe(false);
  });

  it('publishes the latest value after a full quiet period, with the last published prev', () => {
    const source = observable(0);
    const value = debounce(source, schedule);
    const listener = vi.fn();

    value.subscribe(listener);
    source.set(1);
    vi.advanceTimersByTime(60);
    source.set(2);
    vi.advanceTimersByTime(99);

    expect(source.get()).toBe(2);
    expect(value.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(value.get()).toBe(2);
    expect(listener).toHaveBeenCalledExactlyOnceWith(2, 0);

    source.set(3);
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenLastCalledWith(3, 2);
  });

  it('follows eagerly even without downstream subscribers', () => {
    const source = observable('a');
    const value = debounce(source, schedule);

    source.set('b');
    vi.advanceTimersByTime(100);
    expect(value.get()).toBe('b');
  });

  it('does not notify when the source returns to the published value', () => {
    const source = observable(0);
    const value = debounce(source, schedule);
    const listener = vi.fn();

    value.subscribe(listener);
    source.set(1);
    source.set(0);
    vi.advanceTimersByTime(100);
    expect(value.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('uses custom equality on the published value', () => {
    const source = observable({ x: 1 });
    const value = debounce(source, schedule, { equals: (a, b) => a.x === b.x });
    const listener = vi.fn();

    value.subscribe(listener);
    source.set({ x: 1 });
    vi.advanceTimersByTime(100);
    expect(listener).not.toHaveBeenCalled();
    source.set({ x: 2 });
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ x: 2 }, { x: 1 });
  });

  it('schedules once for a batch and composes with computed and effect', () => {
    const source = observable(0);
    const scheduler = vi.fn(schedule);
    const value = debounce(source, scheduler);
    const doubled = computed(() => value.get() * 2, [value]);
    const run = vi.fn(() => doubled.get());
    const stop = effect(run, [doubled]);

    batch(() => {
      source.set(1);
      source.set(2);
    });

    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(doubled.get()).toBe(4);
    expect(run).toHaveLastReturnedWith(4);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    doubled.dispose();
    value.dispose();
  });

  it('cancels pending delivery and unsubscribes once on disposal', () => {
    const source = observable(0);
    const unsubscribe = vi.fn();
    const scheduler = vi.fn(schedule);
    const value = debounce({
      get: () => source.get(),
      subscribe: (listener) => {
        const release = source.subscribe(listener);

        return (): void => { unsubscribe(); release(); };
      },
    }, scheduler);
    const listener = vi.fn();

    value.subscribe(listener);
    source.set(1);
    value.dispose();
    value.dispose();
    expect(vi.getTimerCount()).toBe(0);
    source.set(2);
    vi.advanceTimersByTime(200);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(scheduler).toHaveBeenCalledTimes(1);
    expect(value.get()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores canceled callbacks even when the scheduler still invokes them', () => {
    const callbacks: (() => void)[] = [];
    const cancel = vi.fn();
    const source = observable(0);
    const value = debounce(source, (callback) => {
      callbacks.push(callback);

      return cancel;
    });
    const listener = vi.fn();

    value.subscribe(listener);
    source.set(1);
    source.set(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    callbacks[0]();
    expect(value.get()).toBe(0);
    callbacks[1]();
    callbacks[1]();
    expect(listener).toHaveBeenCalledExactlyOnceWith(2, 0);
    source.set(3);
    value.dispose();
    callbacks[2]();
    expect(value.get()).toBe(2);
  });

  it('does not schedule after disposal during an in-flight source notification', () => {
    const source = observable(0);
    const scheduler = vi.fn(schedule);

    let dispose = (): void => {};

    source.subscribe(() => dispose());

    const value = debounce(source, scheduler);

    dispose = (): void => value.dispose();
    source.set(1);
    expect(scheduler).not.toHaveBeenCalled();
  });

  it('keeps a new change scheduled from inside a delivery', () => {
    const source = observable(0);
    const value = debounce(source, schedule);
    const seen: [number, number][] = [];

    value.subscribe((next, prev) => {
      seen.push([next, prev]);

      if (next === 1) {
        source.set(2);
      }
    });
    source.set(1);
    vi.advanceTimersByTime(100);
    expect(value.get()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([[1, 0], [2, 1]]);
  });

  it('publishes function-valued payloads without calling them as updaters', () => {
    const initial = vi.fn(() => 1);
    const next = vi.fn(() => 2);
    const source = observable<() => number>(initial);
    const value = debounce(source, schedule);

    source.set(() => next);
    vi.advanceTimersByTime(100);
    expect(value.get()).toBe(next);
    expect(next).not.toHaveBeenCalled();
  });

  it('isolates throwing listeners and reports the configured label', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = observable(0);
    const value = debounce(source, schedule, { label: 'quiet' });
    const after = vi.fn();

    value.subscribe(() => { throw new Error('boom'); });
    value.subscribe(after);
    source.set(1);
    vi.advanceTimersByTime(100);
    expect(after).toHaveBeenCalledExactlyOnceWith(1, 0);
    expect(String(error.mock.calls[0]?.[0])).toContain('quiet');
  });
});
