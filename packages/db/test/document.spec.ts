/**
 * The document codec on a direct host and on a component host: the envelope, lazy migration,
 * quarantine instead of loss, chunking under the per-value cap, and refusal on a block entity's
 * budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMPONENT_BUDGET, DIRECT_BUDGET, DbBudgetError, componentHost, createDocumentStore, directHost, prefixed } from '../src/index';
import { ComponentStub, EntityStub } from './stubs';

interface Doc {
  gold: number;
  name: string;
  tags?: string[];
}

function onEntity(options: Partial<Parameters<typeof createDocumentStore<Doc>>[1]> = {}): { entity: EntityStub; store: ReturnType<typeof createDocumentStore<Doc>>; log: ReturnType<typeof vi.fn<(message: string) => void>> } {
  const entity = new EntityStub('e1', 'ns:mob');
  const log = vi.fn<(message: string) => void>();
  const store = createDocumentStore<Doc>(prefixed(directHost(entity), 'core-db:ns:entity::balances:'), { collection: 'balances', log, ...options });

  return { entity, store, log };
}

describe('envelope', () => {
  it('writes one JSON string carrying the version and reads it back', () => {
    const { entity, store } = onEntity({ version: 2 });

    store.write('doc', { gold: 5, name: 'a' });

    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc')).toBe('{"v":2,"d":{"gold":5,"name":"a"}}');
    expect(store.read('doc')).toEqual({ gold: 5, name: 'a' });
  });

  it('answers undefined for a missing document and removes cleanly', () => {
    const { entity, store } = onEntity();

    expect(store.read('doc')).toBeUndefined();
    store.write('doc', { gold: 1, name: 'x' });
    store.remove('doc');
    expect(store.read('doc')).toBeUndefined();
    expect(entity.getDynamicPropertyIds()).toEqual([]);
  });

  it('lists document keys only, not chunks or quarantines', () => {
    const { entity, store } = onEntity();

    store.write('doc', { gold: 1, name: 'a' });
    entity.setDynamicProperty('core-db:ns:entity::balances:doc#bad', 'x');
    entity.setDynamicProperty('core-db:ns:entity::balances:other#0', 'x');
    entity.setDynamicProperty('core-db:ns:entity::other:doc', 'x');

    expect(store.keys()).toEqual(['doc']);
  });
});

describe('migration', () => {
  it('migrates an old document lazily on read, step by step, and rewrites it once', () => {
    const { entity, store: v1 } = onEntity({ version: 1 });

    v1.write('doc', { gold: 7, name: 'old' });

    const steps: number[] = [];
    const v3 = createDocumentStore<Doc>(prefixed(directHost(entity), 'core-db:ns:entity::balances:'), {
      collection: 'balances',
      version: 3,
      migrate: {
        2: (doc) => {
          steps.push(2);

          return { ...doc, name: `${String(doc.name)}!` };
        },
        3: (doc) => {
          steps.push(3);

          return { ...doc, tags: ['migrated'] };
        },
      },
    });

    expect(v3.read('doc')).toEqual({ gold: 7, name: 'old!', tags: ['migrated'] });
    expect(steps).toEqual([2, 3]);
    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc')).toContain('"v":3');

    v3.read('doc');
    expect(steps).toEqual([2, 3]);
  });

  it('quarantines when a step is missing or throws, and when the document is newer than the code', () => {
    const { entity, log } = onEntity();

    entity.setDynamicProperty('core-db:ns:entity::balances:doc', '{"v":1,"d":{"gold":1,"name":"a"}}');

    const gap = createDocumentStore<Doc>(prefixed(directHost(entity), 'core-db:ns:entity::balances:'), { collection: 'balances', version: 3, migrate: { 3: doc => doc }, log });

    expect(gap.read('doc')).toBeUndefined();
    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc')).toBeUndefined();
    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc#bad')).toBe('{"v":1,"d":{"gold":1,"name":"a"}}');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('balances');

    entity.setDynamicProperty('core-db:ns:entity::balances:doc', '{"v":9,"d":{}}');

    const older = createDocumentStore<Doc>(prefixed(directHost(entity), 'core-db:ns:entity::balances:'), { collection: 'balances', version: 2, log });

    expect(older.read('doc')).toBeUndefined();
    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc#bad')).toBe('{"v":9,"d":{}}');
  });

  it('quarantines bytes that are not JSON or not an envelope', () => {
    const { entity, store, log } = onEntity();

    entity.setDynamicProperty('core-db:ns:entity::balances:doc', 'not json');
    expect(store.read('doc')).toBeUndefined();
    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc#bad')).toBe('not json');

    entity.setDynamicProperty('core-db:ns:entity::balances:doc', '[1,2]');
    expect(store.read('doc')).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('budget', () => {
  it('chunks a document past the per-value cap on a direct host and reassembles it', () => {
    const { entity, store } = onEntity();
    const name = 'x'.repeat(DIRECT_BUDGET * 2 + 10);

    store.write('doc', { gold: 1, name });

    const ids = entity.getDynamicPropertyIds().sort();

    expect(ids).toEqual([
      'core-db:ns:entity::balances:doc',
      'core-db:ns:entity::balances:doc#0',
      'core-db:ns:entity::balances:doc#1',
      'core-db:ns:entity::balances:doc#2',
    ]);
    expect(entity.getDynamicProperty('core-db:ns:entity::balances:doc')).toBe('#3');
    expect(store.read('doc')).toEqual({ gold: 1, name });
    expect(store.keys()).toEqual(['doc']);
  });

  it('drops stale chunks when a document shrinks, and all of them on remove', () => {
    const { entity, store } = onEntity();

    store.write('doc', { gold: 1, name: 'x'.repeat(DIRECT_BUDGET * 2) });
    store.write('doc', { gold: 1, name: 'small' });

    expect(entity.getDynamicPropertyIds()).toEqual(['core-db:ns:entity::balances:doc']);
    expect(store.read('doc')).toEqual({ gold: 1, name: 'small' });

    store.write('doc', { gold: 1, name: 'x'.repeat(DIRECT_BUDGET * 3) });
    store.remove('doc');

    expect(entity.getDynamicPropertyIds()).toEqual([]);
  });

  it('refuses a document over a block entity budget before touching the engine', () => {
    const component = new ComponentStub();
    const store = createDocumentStore<Doc>(prefixed(componentHost(component), 'elevators:'), { collection: 'elevators' });

    store.write('doc', { gold: 1, name: 'fits' });
    expect(store.read('doc')).toEqual({ gold: 1, name: 'fits' });

    const big = (): void => {
      store.write('doc', { gold: 1, name: 'x'.repeat(COMPONENT_BUDGET) });
    };

    expect(big).toThrow(DbBudgetError);
    expect(big).toThrow(/elevators/);
    expect(store.read('doc')).toEqual({ gold: 1, name: 'fits' });
  });
});
