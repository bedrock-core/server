/**
 * What peers see of a collection: a version stamp by default, the document with `shared: true`, a
 * derived subset with `{ as }`, nothing without a mirror. Announcements are coalesced to one per
 * document per tick, and a deleted document is withdrawn.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDb, schema } from '../src/index';
import type { Collection, Lifecycle, Mirror, Schema } from '../src/index';
import { EntityStub, WorldStub } from './stubs';

interface Balance {
  coins: number;
  ledger: string[];
}

type SharedOption = boolean | { as(doc: Balance): unknown };

interface LooseDb {
  collection(name: string, options: { schema: Schema<Balance>; shared?: SharedOption }): Collection<Balance, unknown>;
}

function harness(options: { mirror?: boolean } = {}): {
  db: LooseDb;
  set: ReturnType<typeof vi.fn>;
  tick(): void;
} {
  const scheduled: (() => void)[] = [];
  const set = vi.fn<(collection: string, key: string, value: unknown) => void>();
  const lifecycle = {
    schedule: vi.fn((flush: () => void) => { scheduled.push(flush); }),
    tick: (): number => 0,
    attach: vi.fn(),
  };

  const db = createDb({
    world: new WorldStub(),
    namespace: 'ns',
    lifecycle: lifecycle satisfies Lifecycle,
    mirror: options.mirror === false ? undefined : ({ set } satisfies Mirror),
    locate: { bind: target => (): unknown => target, fromIdentity: (): undefined => undefined },
  });

  return {
    db,
    set,
    tick: (): void => {
      for (const flush of scheduled.splice(0)) { flush(); }
    },
  };
}

const balances = (): { schema: Schema<Balance> } => ({
  schema: schema<Balance>({ defaults: { coins: 0, ledger: [] } }),
});

describe('db:shared', () => {
  it('announces a version stamp by default, not the document', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', balances());

    coins.for(new EntityStub('e1')).set({ coins: 10, ledger: ['a'] });
    tick();

    expect(set).toHaveBeenCalledTimes(1);

    const [collection, key, value] = set.mock.calls[0];

    expect(collection).toBe('balances');
    expect(key).toContain('e1');
    // A number, whatever the document weighs.
    expect(typeof value).toBe('number');
  });

  it('bumps the stamp on every write, so a peer query always goes stale', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', balances());
    const doc = coins.for(new EntityStub('e1'));

    doc.set({ coins: 1, ledger: [] });
    tick();
    doc.set({ coins: 2, ledger: [] });
    tick();

    const [, , first] = set.mock.calls[0];
    const [, , second] = set.mock.calls[1];

    expect(second).not.toBe(first);
  });

  it('announces the document itself with shared: true', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', { ...balances(), shared: true });

    coins.for(new EntityStub('e1')).set({ coins: 10, ledger: ['a'] });
    tick();

    expect(set.mock.calls[0][2]).toEqual({ coins: 10, ledger: ['a'] });
  });

  it('announces only the derived subset with { as }', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', { ...balances(), shared: { as: doc => doc.coins } });

    coins.for(new EntityStub('e1')).set({ coins: 10, ledger: ['a', 'b', 'c'] });
    tick();

    // The ledger is the bulk of the document and never leaves this addon.
    expect(set.mock.calls[0][2]).toBe(10);
  });

  it('coalesces a hundred writes in one tick into one announcement', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', { ...balances(), shared: true });
    const doc = coins.for(new EntityStub('e1'));

    for (let i = 1; i <= 100; i++) { doc.set({ coins: i, ledger: [] }); }

    expect(set).not.toHaveBeenCalled();
    tick();

    expect(set).toHaveBeenCalledTimes(1);
    // The last value, not the first.
    expect(set.mock.calls[0][2]).toEqual({ coins: 100, ledger: [] });
  });

  it('announces each document separately', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', { ...balances(), shared: true });

    coins.for(new EntityStub('e1')).set({ coins: 1, ledger: [] });
    coins.for(new EntityStub('e2')).set({ coins: 2, ledger: [] });
    tick();

    expect(set).toHaveBeenCalledTimes(2);
  });

  it('withdraws a deleted document, so a peer does not stay warm on it', () => {
    const { db, set, tick } = harness();
    const coins = db.collection('balances', { ...balances(), shared: true });
    const doc = coins.for(new EntityStub('e1'));

    doc.set({ coins: 10, ledger: [] });
    tick();
    doc.delete();
    tick();

    expect(set.mock.calls[1][2]).toBeUndefined();
  });

  it('announces nothing at all without a mirror', () => {
    const { db, set, tick } = harness({ mirror: false });
    const coins = db.collection('balances', { ...balances(), shared: true });

    coins.for(new EntityStub('e1')).set({ coins: 10, ledger: [] });
    tick();

    expect(set).not.toHaveBeenCalled();
  });
});
