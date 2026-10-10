import { beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, observable } from '../src/index';
import { afterTicks } from '../src/minecraft';

const timers = vi.hoisted(() => ({
  runTimeout: vi.fn<(callback: () => void, ticks: number) => number>(),
  clearRun: vi.fn<(id: number) => void>(),
}));

vi.mock('@minecraft/server', () => ({ system: timers }));
vi.mock('@minecraft/server-ui', () => ({
  ObservableBoolean: class {},
  ObservableNumber: class {},
  ObservableString: class {},
}));

beforeEach(() => {
  timers.runTimeout.mockReset();
  timers.clearRun.mockReset();
});

describe('afterTicks', () => {
  it('creates a scheduler without starting a timer and cancels its returned run ID', () => {
    const schedule = afterTicks(5);
    const callback = vi.fn();

    expect(timers.runTimeout).not.toHaveBeenCalled();
    timers.runTimeout.mockReturnValue(0);

    const cancel = schedule(callback);

    expect(timers.runTimeout).toHaveBeenCalledExactlyOnceWith(callback, 5);
    expect(callback).not.toHaveBeenCalled();
    cancel();
    expect(timers.clearRun).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keeps timers independent when a scheduler is reused', () => {
    timers.runTimeout.mockReturnValueOnce(10).mockReturnValueOnce(11);

    const schedule = afterTicks(20);
    const first = schedule(vi.fn());
    const second = schedule(vi.fn());

    second();
    first();
    expect(timers.clearRun.mock.calls).toEqual([[11], [10]]);
  });

  it('resets a debounce timer and cancels pending delivery on disposal', () => {
    timers.runTimeout.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12);

    const source = observable(0);
    const value = debounce(source, afterTicks(5));
    const listener = vi.fn();

    value.subscribe(listener);
    source.set(1);
    source.set(2);
    expect(timers.runTimeout.mock.calls.map(([, ticks]) => ticks)).toEqual([5, 5]);
    expect(timers.clearRun).toHaveBeenCalledExactlyOnceWith(10);
    timers.runTimeout.mock.calls[0][0]();
    expect(value.get()).toBe(0);
    timers.runTimeout.mock.calls[1][0]();
    expect(listener).toHaveBeenCalledExactlyOnceWith(2, 0);

    source.set(3);
    value.dispose();
    expect(timers.clearRun.mock.calls).toEqual([[10], [12]]);
    timers.runTimeout.mock.calls[2][0]();
    expect(value.get()).toBe(2);
    source.set(4);
    expect(timers.runTimeout).toHaveBeenCalledTimes(3);
  });

  it('passes zero to Minecraft without changing its scheduling semantics', () => {
    const callback = vi.fn();

    afterTicks(0)(callback);
    expect(timers.runTimeout).toHaveBeenCalledExactlyOnceWith(callback, 0);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid tick delay %s before scheduling',
    (ticks) => {
      expect(() => afterTicks(ticks)).toThrow(RangeError);
      expect(timers.runTimeout).not.toHaveBeenCalled();
    },
  );
});
