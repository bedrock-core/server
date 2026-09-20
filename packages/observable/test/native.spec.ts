/**
 * The binding half of the DDUI bridge, against a stub with the engine's measured behaviour: a
 * native observable notifies synchronously, skips an equal value, returns the callback from
 * `subscribe`, and releases only through `unsubscribe(cb)`.
 */
import { describe, expect, it } from 'vitest';
import { observable } from '../src/index';
import { bindNative, type NativeObservable } from '../src/native';

class StubNative<T> implements NativeObservable<T> {
  readonly listeners = new Set<(value: T) => void>();
  sets = 0;
  private _data: T;

  constructor(data: T) {
    this._data = data;
  }

  getData(): T {
    return this._data;
  }

  setData(data: T): void {
    this.sets++;

    if (Object.is(this._data, data)) {
      return;
    }

    this._data = data;

    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  subscribe(callback: (value: T) => void): (value: T) => void {
    this.listeners.add(callback);

    return callback;
  }

  unsubscribe(callback: (value: T) => void): boolean {
    return this.listeners.delete(callback);
  }
}

describe('bindNative', () => {
  it('seeds the native from ours and pushes every change', () => {
    const volume = observable(10);
    const native = new StubNative(0);

    bindNative(volume, native);

    expect(native.getData()).toBe(10);

    volume.set(42);

    expect(native.getData()).toBe(42);
  });

  it('does not push a value the native already holds', () => {
    const volume = observable(10);
    const native = new StubNative(10);

    bindNative(volume, native);

    expect(native.sets).toBe(0);
  });

  it('is one-way unless clientWritable', () => {
    const volume = observable(10);
    const native = new StubNative(0);

    bindNative(volume, native);
    native.setData(99);

    expect(volume.get()).toBe(10);
    expect(native.listeners.size).toBe(0);
  });

  it('writes the player\'s change back when clientWritable, without echoing', () => {
    const volume = observable(10);
    const native = new StubNative(0);
    let notifications = 0;

    volume.subscribe(() => notifications++);
    bindNative(volume, native, { clientWritable: true });
    native.setData(55);

    expect(volume.get()).toBe(55);
    expect(notifications).toBe(1);
    // The push back into the native finds an equal value and stops — no second round.
    expect(native.getData()).toBe(55);
  });

  it('never writes into a readonly source, even when clientWritable', () => {
    const volume = observable(10);
    const readonly = { get: (): number => volume.get(), subscribe: volume.subscribe.bind(volume) };
    const native = new StubNative(0);

    bindNative(readonly, native, { clientWritable: true });
    native.setData(55);

    expect(volume.get()).toBe(10);
  });

  it('dispose releases both directions', () => {
    const volume = observable(10);
    const native = new StubNative(0);
    const dispose = bindNative(volume, native, { clientWritable: true });

    dispose();
    volume.set(1);
    native.setData(2);

    expect(native.getData()).toBe(2);
    expect(volume.get()).toBe(1);
    expect(native.listeners.size).toBe(0);
  });
});
