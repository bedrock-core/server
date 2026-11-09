import { beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce, observable } from '../src/index';
import { afterTicks, toNative, type NativeBinding, type NativeObservable } from '../src/minecraft';

interface NativeFixture<T> {
  binding: NativeBinding<NativeObservable<T>>;
  change(): void;
}

const timers = vi.hoisted(() => ({
  runTimeout: vi.fn<(callback: () => void, ticks: number) => number>(),
  clearRun: vi.fn<(id: number) => void>(),
}));

const nativeTypes = vi.hoisted(() => {
  class StubNative<T> {
    readonly listeners = new Set<(value: T) => void>();

    constructor(private data: T, readonly options: { clientWritable?: boolean } = {}) {}

    getData(): T { return this.data; }

    setData(data: T): void {
      if (Object.is(this.data, data)) { return; }

      this.data = data;

      for (const listener of [...this.listeners]) { listener(data); }
    }

    subscribe(callback: (value: T) => void): (value: T) => void {
      this.listeners.add(callback);

      return callback;
    }

    unsubscribe(callback: (value: T) => void): boolean { return this.listeners.delete(callback); }
  }

  return {
    ObservableBoolean: class extends StubNative<boolean> {},
    ObservableNumber: class extends StubNative<number> {},
    ObservableString: class extends StubNative<string> {},
  };
});

vi.mock('@minecraft/server', () => ({ system: timers }));
vi.mock('@minecraft/server-ui', () => nativeTypes);

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

describe('toNative', () => {
  it.each([
    {
      kind: 'number', constructor: nativeTypes.ObservableNumber, initial: 10, next: 25,
      setup: (): NativeFixture<number> => {
        const source = observable(10);

        return { binding: toNative(source), change: (): void => source.set(25) };
      },
    },
    {
      kind: 'string', constructor: nativeTypes.ObservableString, initial: 'initial', next: 'updated',
      setup: (): NativeFixture<string> => {
        const source = observable('initial');

        return { binding: toNative(source), change: (): void => source.set('updated') };
      },
    },
    {
      kind: 'boolean', constructor: nativeTypes.ObservableBoolean, initial: false, next: true,
      setup: (): NativeFixture<boolean> => {
        const source = observable(false);

        return { binding: toNative(source), change: (): void => source.set(true) };
      },
    },
  ])('constructs and updates the native $kind observable', ({ constructor, initial, next, setup }) => {
    const { binding, change } = setup();

    expect(binding.native).toBeInstanceOf(constructor);
    expect(binding.native).toMatchObject({ options: { clientWritable: false } });
    expect(binding.native.getData()).toBe(initial);
    change();
    expect(binding.native.getData()).toBe(next);
    binding.dispose();
  });

  it('passes client write permission to the native and releases both binding directions', () => {
    const source = observable(10);
    const { native, dispose } = toNative(source, { clientWritable: true });
    const changed = vi.fn();
    const unsubscribe = source.subscribe(changed);

    expect(native).toMatchObject({ options: { clientWritable: true } });
    native.setData(20);
    expect(source.get()).toBe(20);
    expect(changed).toHaveBeenCalledExactlyOnceWith(20, 10);
    dispose();
    dispose();
    expect(native).toMatchObject({ listeners: new Set() });
    source.set(30);
    expect(native.getData()).toBe(20);
    native.setData(40);
    expect(source.get()).toBe(30);
    unsubscribe();
  });
});
