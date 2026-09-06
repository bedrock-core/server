/**
 * The contract every other package leans on: synchronous delivery, `equals` deciding whether a
 * set is a change, listeners isolated from each other, and `batch` collapsing a burst into one
 * notification per observable — including none at all for a value that changed and changed back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { batch, computed, effect, observable } from '../src/index';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observable', () => {
  it('reads the initial value and notifies with next and prev', () => {
    const count = observable(1);
    const seen: [number, number][] = [];

    count.subscribe((next, prev) => seen.push([next, prev]));
    count.set(2);

    expect(count.get()).toBe(2);
    expect(seen).toEqual([[2, 1]]);
  });

  it('delivers synchronously, inside set', () => {
    const count = observable(0);
    let duringSet = -1;

    count.subscribe((next) => { duringSet = next; });
    count.set(5);

    expect(duringSet).toBe(5);
  });

  it('accepts an updater', () => {
    const count = observable(1);

    count.set(prev => prev + 10);

    expect(count.get()).toBe(11);
  });

  it('does not notify when equals says nothing changed', () => {
    const count = observable(1);
    const listener = vi.fn();

    count.subscribe(listener);
    count.set(1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('uses a custom equals', () => {
    const point = observable({ x: 1 }, { equals: (a, b) => a.x === b.x });
    const listener = vi.fn();

    point.subscribe(listener);
    point.set({ x: 1 });
    point.set({ x: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes', () => {
    const count = observable(0);
    const listener = vi.fn();
    const unsubscribe = count.subscribe(listener);

    unsubscribe();
    count.set(1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('lets a listener unsubscribe itself mid-delivery without skipping the others', () => {
    const count = observable(0);
    const second = vi.fn();
    const unsubscribeFirst = count.subscribe(() => unsubscribeFirst());

    count.subscribe(second);
    count.set(1);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener and reports it with the label', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const count = observable(0, { label: 'count' });
    const after = vi.fn();

    count.subscribe(() => { throw new Error('boom'); });
    count.subscribe(after);
    count.set(1);

    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('count');
  });
});

describe('batch', () => {
  it('delivers once per observable, with the final value and the pre-batch prev', () => {
    const count = observable(0);
    const seen: [number, number][] = [];

    count.subscribe((next, prev) => seen.push([next, prev]));
    batch(() => {
      count.set(1);
      count.set(2);
      count.set(3);
    });

    expect(seen).toEqual([[3, 0]]);
  });

  it('delivers nothing for a value that changed and changed back', () => {
    const count = observable(0);
    const listener = vi.fn();

    count.subscribe(listener);
    batch(() => {
      count.set(1);
      count.set(0);
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('reads the new value inside the batch even though listeners wait', () => {
    const count = observable(0);
    const listener = vi.fn();

    count.subscribe(listener);
    batch(() => {
      count.set(1);

      expect(count.get()).toBe(1);
      expect(listener).not.toHaveBeenCalled();
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('flushes nested batches at the outermost', () => {
    const count = observable(0);
    const listener = vi.fn();

    count.subscribe(listener);
    batch(() => {
      batch(() => { count.set(1); });

      expect(listener).not.toHaveBeenCalled();
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps delivery order and stays synchronous when a listener sets another observable', () => {
    const a = observable(0);
    const b = observable(0);
    const order: string[] = [];

    a.subscribe(() => { order.push('a'); b.set(1); });
    b.subscribe(() => order.push('b'));
    batch(() => { a.set(1); });

    expect(order).toEqual(['a', 'b']);
  });

  it('still flushes when fn throws', () => {
    const count = observable(0);
    const listener = vi.fn();

    count.subscribe(listener);

    expect(() => batch(() => {
      count.set(1);
      throw new Error('boom');
    })).toThrow('boom');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('computed', () => {
  it('derives, recomputes on a dependency change and notifies only on a different result', () => {
    const alive = observable(new Set(['a', 'b']));
    const count = computed(() => alive.get().size, [alive]);
    const listener = vi.fn();

    count.subscribe(listener);

    expect(count.get()).toBe(2);

    alive.set(new Set(['a', 'b', 'c']));

    expect(count.get()).toBe(3);
    expect(listener).toHaveBeenCalledWith(3, 2);

    alive.set(new Set(['x', 'y', 'z']));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('recomputes exactly once per batch however many dependencies changed', () => {
    const a = observable(1);
    const b = observable(2);
    const compute = vi.fn(() => a.get() + b.get());
    const sum = computed(compute, [a, b]);
    const listener = vi.fn();

    sum.subscribe(listener);
    compute.mockClear();

    batch(() => {
      a.set(10);
      b.set(20);
    });

    expect(compute).toHaveBeenCalledTimes(1);
    expect(sum.get()).toBe(30);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('chains', () => {
    const base = observable(2);
    const doubled = computed(() => base.get() * 2, [base]);
    const quadrupled = computed(() => doubled.get() * 2, [doubled]);

    base.set(3);

    expect(quadrupled.get()).toBe(12);
  });

  it('keeps the previous value when compute throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const base = observable(1);
    const derived = computed(() => {
      if (base.get() < 0) { throw new Error('negative'); }

      return base.get() * 2;
    }, [base]);

    base.set(-1);

    expect(derived.get()).toBe(2);
  });

  it('stops following after dispose', () => {
    const base = observable(1);
    const derived = computed(() => base.get() * 2, [base]);

    derived.dispose();
    base.set(5);

    expect(derived.get()).toBe(2);
  });
});

describe('effect', () => {
  it('runs immediately, then on every dependency change, until unsubscribed', () => {
    const phase = observable('lobby');
    const run = vi.fn();
    const stop = effect(run, [phase]);

    expect(run).toHaveBeenCalledTimes(1);

    phase.set('fight');

    expect(run).toHaveBeenCalledTimes(2);

    stop();
    phase.set('end');

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs once per batch', () => {
    const a = observable(0);
    const b = observable(0);
    const run = vi.fn();

    effect(run, [a, b]);
    run.mockClear();
    batch(() => {
      a.set(1);
      b.set(1);
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports a throwing run and stays attached', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const count = observable(0);
    let runs = 0;

    effect(() => {
      runs++;
      throw new Error('boom');
    }, [count]);
    count.set(1);

    expect(runs).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
