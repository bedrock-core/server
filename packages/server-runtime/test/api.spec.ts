import { batch, computed, effect, observable, signal, toSignal, type ReadonlyObservable } from '@bedrock-core/observable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiModuleShape } from '../src/api';
import type { ApiReferenceShape } from '../src/api/types';
import type { AddonManifest } from '../src/manifest';
import type { Codec } from '../src/api';
import { decodeWire, encodeBatch } from '../../sync/src/wire';
import { encodeEnvelope } from '../../sync/src/envelope';
import { BUS_CHANNEL, MessageType } from '../../sync/src/constants';

const engine = vi.hoisted(() => {
  class Entity {
    isValid = true;
    tags = new Set<string>();
    constructor(readonly id: string) {}
    addTag(tag: string): void { this.tags.add(tag); }
  }
  class Player extends Entity {}

  return {
    Entity, Player,
    entities: new Map<string, Entity>(),
    tick: 0,
    next: 0,
    tasks: new Map<number, { at: number; repeat: number; run: () => void }>(),
    listeners: new Set<(event: { id: string; message: string }) => void>(),
    messages: [] as string[],
  };
});

function schedule(run: () => void, delay = 1, repeat = 0): number {
  const id = ++engine.next;

  engine.tasks.set(id, { at: engine.tick + Math.max(1, delay), repeat, run });

  return id;
}

vi.mock('@minecraft/server', () => ({
  Entity: engine.Entity,
  Player: engine.Player,
  world: { getEntity: (id: string): InstanceType<typeof engine.Entity> | undefined => engine.entities.get(id) },
  system: {
    get currentTick(): number { return engine.tick; },
    run: (run: () => void): number => schedule(run),
    runTimeout: (run: () => void, delay: number): number => schedule(run, delay),
    runInterval: (run: () => void, period: number): number => schedule(run, period, period),
    clearRun: (id: number): void => { engine.tasks.delete(id); },
    sendScriptEvent: (id: string, message: string): void => {
      engine.messages.push(message);

      for (const listener of [...engine.listeners]) { listener({ id, message }); }
    },
    afterEvents: {
      scriptEventReceive: {
        subscribe: (listener: (event: { id: string; message: string }) => void): typeof listener => {
          engine.listeners.add(listener);

          return listener;
        },
        unsubscribe: (listener: (event: { id: string; message: string }) => void): void => { engine.listeners.delete(listener); },
      },
    },
  },
}));

// These tests run the actual Runtime, Bus, queue, framing, discovery, RPC, mirror and events.
// Persistence is unrelated to the public API boundary.
vi.mock('@bedrock-core/db/minecraft', () => ({ createEngineDb: (): object => ({ stop(): void {} }) }));

const { Runtime, core } = await import('../src/runtime');
const { createApiModule, provideApiModule } = await import('../src/api');
const { defineApiDeclaration, defineApiModule, registerApi } = await import('../src/api/declaration');
const { createClientApiModule, stopApiClient } = await import('../src/api/client');
const { MAX_MESSAGE } = await import('../../sync/src/constants');
const { SyncNode } = await import('../../sync/src/node');
const runtimes: InstanceType<typeof Runtime>[] = [];
const syncNodes: InstanceType<typeof SyncNode>[] = [];

class Money {
  static readonly codec: Codec<Money, number> = {
    encode: value => value.gold,
    decode: (gold) => {
      if (typeof gold !== 'number' || !Number.isFinite(gold)) { throw new TypeError('invalid gold'); }

      return new Money(gold);
    },
  };

  constructor(readonly gold: number) {}

  format(): string { return `${this.gold} gold`; }
}

const moneyData = { kind: 'codec', codec: Money.codec } as const;

function runtime(): InstanceType<typeof Runtime> {
  const instance = new Runtime();

  runtimes.push(instance);

  return instance;
}

function manifest(namespace: string): AddonManifest {
  return { format_version: 3, namespace, header: { name: namespace, version: '1.0.0' }, modules: [{ type: 'script' }] };
}

async function ticks(count = 8): Promise<void> {
  for (let i = 0; i < count; i++) {
    engine.tick++;

    for (const [id, task] of [...engine.tasks]) {
      if (task.at > engine.tick || engine.tasks.get(id) !== task) { continue; }

      if (task.repeat > 0) { task.at += task.repeat; } else { engine.tasks.delete(id); }

      task.run();
    }

    for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); }
  }
}

function eventSource<T>(): {
  emit(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
  size(): number;
} {
  const events = signal<T>();
  let active = 0;

  return {
    emit: events.emit,
    subscribe(listener): () => void {
      const release = events.subscribe(listener);
      let subscribed = true;

      active++;

      return (): void => {
        if (!subscribed) { return; }

        subscribed = false;
        active--;
        release();
      };
    },
    size: (): number => active,
  };
}

const shape = {
  kind: 'object',
  members: {
    sum: { kind: 'function' },
    echo: { kind: 'function' },
    fail: { kind: 'function' },
    empty: { kind: 'function' },
    never: { kind: 'function' },
    current: { kind: 'state' },
    changed: { kind: 'event' },
    info: {
      kind: 'object',
      members: { currency: { kind: 'value', value: 'Gold' }, limits: { kind: 'value', value: [1, 10] } },
    },
  },
} as const satisfies ApiModuleShape;

function source(): {
  sum(left: number, right: number, unit?: string): Promise<string>;
  echo(...args: unknown[]): Promise<unknown[]>;
  fail(): Promise<never>;
  empty(): Promise<void>;
  never(): Promise<never>;
  current: ReturnType<typeof observable<number>>;
  changed: ReturnType<typeof eventSource<{ amount: number }>>;
  info: { currency: 'Gold'; limits: readonly [1, 10] };
} {
  return {
    sum: async (left, right, unit = 'G') => `${left + right}${unit}`,
    echo: async (...args) => args,
    fail: async (): Promise<never> => { throw new Error('insufficient funds'); },
    empty: async () => undefined,
    never: () => new Promise<never>(() => undefined),
    current: observable(2),
    changed: eventSource(),
    info: { currency: 'Gold', limits: [1, 10] },
  };
}

function pair(): { owner: InstanceType<typeof Runtime>; consumer: InstanceType<typeof Runtime>; exports: ReturnType<typeof source>; release: () => void } {
  const owner = runtime();
  const consumer = runtime();
  const exports = source();
  const release = owner.api.provideModule('@fixture/economy', shape, exports);

  owner.register({ manifest: manifest('economy') });
  consumer.register({ manifest: manifest('shop') });

  return { owner, consumer, exports, release };
}

beforeEach(() => {
  engine.entities.clear();
  engine.tick = 0;
  engine.next = 0;
  engine.messages = [];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
  stopApiClient();

  for (const instance of runtimes.splice(0)) { instance.stop(); }

  for (const node of syncNodes.splice(0)) { node.stop(); }

  core.stop();
  await ticks(1);
  expect(engine.listeners.size).toBe(0);
  expect(engine.tasks.size).toBe(0);
  vi.restoreAllMocks();
});

describe('public package peers over the Runtime transport', () => {
  it('preserves a complete manifest across framed discovery and API readiness updates', async () => {
    const owner = runtime();
    const consumer = runtime();
    const authored: AddonManifest = {
      ...manifest('owner'),
      header: { name: 'pack.name', description: 'manifest '.repeat(900), version: '4.2.3', uuid: 'owning-pack' },
      metadata: { authors: ['First', 'Second'], license: 'MIT', url: 'https://example.com', generated_with: { builder: ['1.0.0'] } },
      dependencies: [{ module_name: '@minecraft/server', version: '2.10.0' }, { namespace: 'consumer', uuid: 'consumer-pack', version: '1.0.0' }],
      optionalDependencies: [{ namespace: 'extra', uuid: 'extra-pack', version: '2.0.0' }],
      capabilities: ['pbr'],
      subpacks: [{ folder_name: 'detail', name: 'Detail', memory_performance_tier: 1 }],
      thumbnail: 'textures/owner/thumbnail',
    };

    owner.register({ manifest: authored });
    consumer.register({ manifest: manifest('consumer') });
    await ticks(32);
    expect(owner.registry.get('owner')?.manifest).toBe(owner.manifest);
    expect(consumer.registry.get('owner')?.manifest).toEqual(authored);
    expect(consumer.registry.get('owner')).not.toHaveProperty('packName');
    expect(consumer.registry.get('owner')).not.toHaveProperty('version');
    expect(owner.registry.missingDependencies()).toEqual([]);
    owner.api.provideModule('@fixture/rich-manifest', shape, source());
    await ticks(32);
    expect(consumer.registry.get('owner')?.apis).toContain('@fixture/rich-manifest');
    expect(consumer.registry.get('owner')?.manifest).toEqual(authored);
    expect(owner.manifest.header.name).toBe('pack.name');
  });

  it('selects an exported API object or its module namespace through the same checked contract', async () => {
    const owner = runtime();
    const consumer = runtime();
    const API = source();
    const exports = { API };
    const contract = { kind: 'object', members: { API: shape } } as const;

    defineApiModule('@fixture/object-view', contract, exports);
    owner.register({ manifest: manifest('owner'), api: registerApi(API) });
    consumer.register({ manifest: manifest('consumer') });
    const object = consumer.api.of('owner', API);
    const module = consumer.api.of('owner', exports);
    const result = object.sum(2, 3);

    await ticks();
    expect(await result).toBe('5G');
    expect(module.API.current.get()).toBe(2);
    expect('set' in object.current).toBe(false);
    expect(() => consumer.api.of('owner', {})).toThrow('no generated contract');
  });

  it('isolates library declaration instances by owner and withdraws only the stopped instance', async () => {
    const first = runtime();
    const second = runtime();
    const consumer = runtime();
    const a = source();
    const b = source();

    b.current.set(7);
    const declarationA = defineApiDeclaration('@fixture/library#create:checked', shape, registerApi(a));
    const declarationB = defineApiDeclaration('@fixture/library#create:checked', shape, registerApi(b));

    expect(declarationA.api).toBe(a);
    first.register({ manifest: manifest('first'), api: declarationA });
    second.register({ manifest: manifest('second'), api: declarationB });
    consumer.register({ manifest: manifest('consumer') });
    const viewA = consumer.api.of('first', a);
    const viewB = consumer.api.of('second', a);

    await ticks();
    expect(viewA.current.get()).toBe(2);
    expect(viewB.current.get()).toBe(7);
    declarationA.stop?.();
    b.current.set(9);
    await ticks();
    expect(viewA.current.get()).toBeUndefined();
    expect(viewB.current.get()).toBe(9);
    const result = viewB.sum(4, 5);

    await ticks();
    expect(await result).toBe('9G');
    expect(second.registry.get('second')?.apis).toContain('@fixture/library#create:checked');
  });

  it('publishes exported implementation objects only through their owning API declaration', async () => {
    const owner = runtime();
    const consumer = runtime();
    const API = source();
    const module = { API };
    const contract = { kind: 'object', members: { API: shape } } as const;

    defineApiModule('@fixture/declared', contract, module);
    owner.register({ manifest: manifest('economy') });
    consumer.register({ manifest: manifest('shop') });
    expect(owner.registry.get('economy')?.apis).not.toContain('@fixture/declared');
    const declaration = registerApi(API);
    const installed = owner.install(declaration);

    expect(installed).toBe(API);
    const client = consumer.api.createModule<typeof module>('economy', '@fixture/declared', contract);
    const result = client.API.sum(2, 3);

    await ticks();
    expect(await result).toBe('5G');
    expect(client.API.current.get()).toBe(2);
    expect('set' in client.API.current).toBe(false);
    expect('emit' in client.API.changed).toBe(false);
    declaration.stop?.();
    declaration.stop?.();
    await ticks();
    expect(owner.registry.get('economy')?.apis).not.toContain('@fixture/declared');
    expect(client.API.current.get()).toBeUndefined();
  });

  it('installs API declarations in core.register and withdraws them during reverse cleanup', () => {
    const owner = runtime();
    const API = source();
    const contract = { kind: 'object', members: { API: shape } } as const;

    defineApiModule('@fixture/registered', contract, { API });
    const { api } = owner.register({ manifest: manifest('economy'), api: registerApi(API) });

    expect(api).toBe(API);
    expect(owner.registry.get('economy')?.apis).toContain('@fixture/registered');
    owner.stop();
    expect(API.changed.size()).toBe(0);
  });

  it('rejects API objects without generated metadata and rolls registration back', () => {
    const owner = runtime();

    expect(() => owner.register({ manifest: manifest('economy'), api: registerApi(source()) })).toThrow('Builder public API entry');
    expect(owner.registered).toBe(false);
    expect(engine.listeners.size).toBe(0);
  });

  it('rolls back partially installed API entries without withdrawing an existing module', () => {
    const owner = runtime();
    const API = source();
    const contract = { kind: 'object', members: { API: shape } } as const;

    defineApiModule('@fixture/first', contract, { API });
    defineApiModule('@fixture/taken', contract, { API });
    owner.register({ manifest: manifest('economy') });
    owner.api.provideModule('@fixture/taken', shape, source());
    expect(() => owner.install(registerApi(API))).toThrow('already provided');
    expect(owner.registry.get('economy')?.apis).not.toContain('@fixture/first');
    expect(owner.registry.get('economy')?.apis).toContain('@fixture/taken');
    expect(API.changed.size()).toBe(0);
  });

  it('withdraws every API entry even when a source unsubscribe throws', () => {
    const owner = runtime();
    let subscriptions = 0;
    const API = { changed: { subscribe(): () => void {
      subscriptions++;

      return (): void => {
        subscriptions--;
        throw new Error('source cleanup failed');
      };
    } } };
    const contract = { kind: 'object', members: { API: { kind: 'object', members: { changed: { kind: 'event' } } } } } as const;

    defineApiModule('@fixture/cleanup-first', contract, { API });
    defineApiModule('@fixture/cleanup-second', contract, { API });
    const declaration = registerApi(API);

    owner.register({ manifest: manifest('economy'), api: declaration });
    expect(subscriptions).toBe(2);
    expect(() => declaration.stop?.()).toThrow('API declaration cleanup failed');
    expect(subscriptions).toBe(0);
    expect(owner.registry.get('economy')?.apis).toEqual([]);
    expect(() => declaration.stop?.()).not.toThrow();
  });

  it('starts one portable consumer endpoint lazily without advertising a registered addon', async () => {
    const owner = runtime();
    const exports = source();

    owner.api.provideModule('@fixture/economy', shape, exports);
    owner.register({ manifest: manifest('economy') });
    const client = createClientApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const second = createClientApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);

    expect(engine.listeners.size).toBe(1);
    const result = client.sum(2, 3);

    await ticks();
    expect(await result).toBe('5G');
    expect(second.current.get()).toBe(2);
    expect(engine.listeners.size).toBe(2);
    expect(owner.registry.all().map(addon => addon.id)).toEqual(['economy']);
    stopApiClient();
    expect(engine.listeners.size).toBe(1);
  });

  it('uses registered Core instead of starting another portable consumer endpoint', async () => {
    const owner = runtime();

    owner.api.provideModule('@fixture/economy', shape, source());
    owner.register({ manifest: manifest('economy') });
    core.register({ manifest: manifest('shop') });
    const client = createClientApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const result = client.sum(3, 4);

    await ticks();
    expect(await result).toBe('7G');
    expect(engine.listeners.size).toBe(2);
    stopApiClient();
    expect(core.registered).toBe(true);
    expect(engine.listeners.size).toBe(2);
  });

  it('adopts Core registered after portable use and reconnects state and event subscriptions', async () => {
    const owner = runtime();
    const exports = source();

    owner.api.provideModule('@fixture/economy', shape, exports);
    owner.register({ manifest: manifest('economy') });
    const client = createClientApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const values: (number | undefined)[] = [];
    const events: number[] = [];
    const stopState = client.current.subscribe(value => values.push(value));
    const stopEvents = client.changed.subscribe(value => events.push(value.amount));

    await ticks();
    core.register({ manifest: manifest('shop') });
    await ticks();
    exports.current.set(9);
    exports.changed.emit({ amount: 9 });
    await ticks();
    expect(client.current.get()).toBe(9);
    expect(values).toContain(9);
    expect(events).toEqual([9]);
    expect(engine.listeners.size).toBe(2);
    stopState();
    stopEvents();
  });

  it('drains an active portable call and its callbacks while new calls use Core', async () => {
    const owner = runtime();

    let resume = (): void => {};

    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let entered = 0;
    let retained: (() => Promise<number>) | undefined;
    const exports = {
      async wait(callback: () => Promise<number>): Promise<number> {
        entered++;
        retained = callback;
        await gate;

        return await callback() + 1;
      },
      async now(): Promise<string> { return 'ready'; },
    };
    const shape = { kind: 'object', members: {
      wait: { kind: 'function', parameters: { items: [{ kind: 'callback' }] } }, now: { kind: 'function' },
    } } as const;

    owner.api.provideModule('@fixture/drain', shape, exports);
    owner.register({ manifest: manifest('provider') });
    const client = createClientApiModule<typeof exports>('provider', '@fixture/drain', shape);
    const callback = vi.fn(async () => 4);
    const waiting = client.wait(callback);

    await ticks();
    expect(entered).toBe(1);
    core.register({ manifest: manifest('consumer') });
    expect(engine.listeners.size).toBe(3);
    const current = client.now();

    await ticks();
    expect(await current).toBe('ready');
    expect(engine.listeners.size).toBe(3);
    resume();
    await ticks();
    expect(await waiting).toBe(5);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(entered).toBe(1);
    expect(engine.listeners.size).toBe(2);
    await expect(retained?.()).rejects.toThrow('ended');
  });

  it('keeps portable calls waiting for discovery alive during Core registration', async () => {
    const owner = runtime();

    owner.api.provideModule('@fixture/economy', shape, source());
    owner.register({ manifest: manifest('economy') });
    const client = createClientApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const waiting = client.sum(2, 3);

    core.register({ manifest: manifest('consumer') });
    await ticks();
    expect(await waiting).toBe('5G');
    expect(engine.listeners.size).toBe(2);
  });

  it('can return a Core-owned object from a callback started on the portable endpoint', async () => {
    const owner = runtime();
    const object = { async value(): Promise<number> { return 6; } };
    const reference = { kind: 'reference', reference: 'api', contract: 'unit:callback-handover', shape: { kind: 'object', members: { value: { kind: 'function' } } } } as const;
    const shape = { kind: 'object', members: { run: { kind: 'function', parameters: { items: [{ kind: 'callback', result: reference }] } } } } as const;
    const exports = { async run(callback: () => Promise<typeof object>): Promise<number> { return await (await callback()).value(); } };

    owner.api.provideModule('@fixture/callback-handover', shape, exports);
    owner.register({ manifest: manifest('provider') });
    const client = createClientApiModule<typeof exports>('provider', '@fixture/callback-handover', shape);
    const called = client.run(async () => {
      core.register({ manifest: manifest('consumer') });

      return object;
    });

    await ticks(20);
    expect(await called).toBe(6);
    expect(core.api.release(object)).toBe(true);
    expect(engine.listeners.size).toBe(2);
  });

  it('keeps retained portable objects callable, observable and forwardable through Core', async () => {
    const owner = runtime();
    const balance = observable(0);
    const changed = signal<number>();
    const account = { balance, changed, async deposit(amount: number): Promise<number> {
      balance.set(amount);
      changed.emit(amount);

      return amount;
    } };
    const reference = { kind: 'reference', reference: 'api', contract: 'unit:portable-account', shape: { kind: 'object', members: {
      balance: { kind: 'state' }, changed: { kind: 'event' }, deposit: { kind: 'function' },
    } } } as const;
    const shape = { kind: 'object', members: {
      open: { kind: 'function', result: reference }, identity: { kind: 'function', parameters: { items: [reference] } },
    } } as const;
    const exports = { async open(): Promise<typeof account> { return account; }, async identity(value: typeof account): Promise<boolean> { return value === account; } };

    owner.api.provideModule('@fixture/portable-objects', shape, exports);
    owner.register({ manifest: manifest('provider') });
    const client = createClientApiModule<typeof exports>('provider', '@fixture/portable-objects', shape);
    const opened = client.open();

    await ticks();
    const retained = await opened;
    const values: number[] = [];
    const events: number[] = [];
    const stopState = retained.balance.subscribe(value => values.push(value));
    const stopEvents = retained.changed.subscribe(value => events.push(value));

    core.register({ manifest: manifest('consumer') });
    const deposited = retained.deposit(7);
    const forwarded = client.identity(retained);
    const reopened = client.open();

    await ticks();
    expect(await deposited).toBe(7);
    expect(await forwarded).toBe(true);
    expect(await reopened).toBe(retained);
    expect(retained.balance.get()).toBe(7);
    expect(values).toContain(7);
    expect(events).toEqual([7]);
    expect(engine.listeners.size).toBe(2);
    owner.api.release(account);
    await ticks();
    expect(retained.balance.get()).toBeUndefined();
    await expect(retained.deposit(9)).rejects.toThrow('unavailable');
    await expect(client.identity(retained)).rejects.toThrow('unavailable');
    stopState();
    stopEvents();
  });

  it('retains objects returned by a call that completes after Core registration', async () => {
    const owner = runtime();

    let resume = (): void => {};

    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const object = { async value(): Promise<number> { return 8; } };
    const reference = { kind: 'reference', reference: 'api', contract: 'unit:late-result', shape: { kind: 'object', members: { value: { kind: 'function' } } } } as const;
    const shape = { kind: 'object', members: { open: { kind: 'function', result: reference } } } as const;
    const exports = { async open(): Promise<typeof object> {
      await gate;

      return object;
    } };

    owner.api.provideModule('@fixture/late-result', shape, exports);
    owner.register({ manifest: manifest('provider') });
    const client = createClientApiModule<typeof exports>('provider', '@fixture/late-result', shape);
    const opened = client.open();

    await ticks();
    core.register({ manifest: manifest('consumer') });
    resume();
    await ticks();
    const retained = await opened;
    const called = retained.value();

    await ticks();
    expect(await called).toBe(8);
    expect(engine.listeners.size).toBe(2);
  });

  it('cleans a draining endpoint after timeout or explicit client shutdown', async () => {
    const owner = runtime();

    owner.api.provideModule('@fixture/economy', shape, source());
    owner.register({ manifest: manifest('economy') });
    const client = createClientApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const expired = expect(client.never()).rejects.toThrow('timed out');

    await ticks();
    core.register({ manifest: manifest('consumer') });
    await ticks(220);
    await expired;
    expect(engine.listeners.size).toBe(2);
    core.stop();
    const cancelled = expect(client.never()).rejects.toThrow('RPC stopped');

    await ticks();
    core.register({ manifest: manifest('consumer') });
    expect(engine.listeners.size).toBe(3);
    stopApiClient();
    await cancelled;
    expect(engine.listeners.size).toBe(2);
    expect(core.registered).toBe(true);
  });

  it('fences draining calls and retained portable handles when their provider is replaced', async () => {
    const owner = runtime();
    const object = { async value(): Promise<number> { return 1; } };
    const reference = { kind: 'reference', reference: 'api', contract: 'unit:handover-instance', shape: { kind: 'object', members: { value: { kind: 'function' } } } } as const;
    const shape = { kind: 'object', members: { open: { kind: 'function', result: reference }, never: { kind: 'function' } } } as const;
    const exports = { async open(): Promise<typeof object> { return object; }, never: (): Promise<never> => new Promise(() => undefined) };

    owner.api.provideModule('@fixture/handover-instance', shape, exports);
    owner.register({ manifest: manifest('provider') });
    const client = createClientApiModule<typeof exports>('provider', '@fixture/handover-instance', shape);
    const opened = client.open();

    await ticks();
    const retained = await opened;
    const waiting = expect(client.never()).rejects.toThrow('stopped');

    await ticks();
    core.register({ manifest: manifest('consumer') });
    owner.stop();
    const replacement = runtime();

    replacement.api.provideModule('@fixture/handover-instance', shape, exports);
    replacement.register({ manifest: manifest('provider') });
    await ticks();
    await waiting;
    await expect(retained.value()).rejects.toThrow('unavailable');
    const renewed = client.open();

    await ticks();
    expect(await renewed).not.toBe(retained);
    expect(engine.listeners.size).toBe(2);
  });

  it('can resume retained portable handles on a fresh endpoint after Core stops', async () => {
    const owner = runtime();
    const object = { async value(): Promise<number> { return 3; } };
    const reference = { kind: 'reference', reference: 'api', contract: 'unit:resume-portable', shape: { kind: 'object', members: { value: { kind: 'function' } } } } as const;
    const shape = { kind: 'object', members: { open: { kind: 'function', result: reference } } } as const;
    const exports = { async open(): Promise<typeof object> { return object; } };

    owner.api.provideModule('@fixture/resume-portable', shape, exports);
    owner.register({ manifest: manifest('provider') });
    const client = createClientApiModule<typeof exports>('provider', '@fixture/resume-portable', shape);
    const opened = client.open();

    await ticks();
    const retained = await opened;

    core.register({ manifest: manifest('consumer') });
    await ticks();
    core.stop();
    const called = retained.value();

    await ticks();
    expect(await called).toBe(3);
    const reopened = client.open();

    await ticks();
    expect(await reopened).toBe(retained);
    expect(engine.listeners.size).toBe(2);
  });

  it('normalizes explicit provider signals to cleanup-return consumer handles', async () => {
    const owner = runtime();
    const consumer = runtime();
    const state = observable<number | undefined>(1);
    const events = signal<number>();
    const eventStops = new Map<(value: number) => void, () => void>();
    const stateRemoval = vi.fn();
    const eventRemoval = vi.fn((listener: (value: number) => void) => { eventStops.get(listener)?.(); eventStops.delete(listener); });
    const exports = {
      current: { get: (): number | undefined => state.get(), subscribe(listener: (next: number | undefined, previous: number | undefined) => void): () => void {
        const release = state.subscribe(listener);

        return (): void => { stateRemoval(); release(); };
      } },
      changed: toSignal({ subscribe(listener: (value: number) => void): void { eventStops.set(listener, events.subscribe(listener)); }, unsubscribe: eventRemoval }),
    };
    const explicitShape = { kind: 'object', members: {
      current: { kind: 'state' }, changed: { kind: 'event' },
    } } as const;

    owner.api.provideModule('@fixture/explicit', explicitShape, exports);
    owner.register({ manifest: manifest('explicit_owner') });
    consumer.register({ manifest: manifest('explicit_consumer') });
    const client = consumer.api.createModule<typeof exports>('explicit_owner', '@fixture/explicit', explicitShape);

    await ticks();
    const changed = vi.fn();
    const current = vi.fn();

    const stopFirst = client.changed.subscribe(changed);
    const stopSecond = client.changed.subscribe(changed);
    const stopState = client.current.subscribe(current);

    expect(client.changed).not.toHaveProperty('unsubscribe');
    events.emit(2);
    state.set(2);
    await ticks();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledWith(2, 1);
    stopFirst();
    stopSecond();
    stopState();
    const stop = client.changed.subscribe(changed);

    events.emit(3);
    await ticks();
    expect(changed).toHaveBeenCalledTimes(3);
    stop(); stop();
    events.emit(4);
    await ticks();
    expect(changed).toHaveBeenCalledTimes(3);
    owner.stop();
    expect(stateRemoval).toHaveBeenCalledTimes(1);
    expect(eventRemoval).toHaveBeenCalledTimes(1);
  });

  it('keeps default API snapshots/events subscribe-only with independent cleanup handles', async () => {
    const { owner, consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const listener = vi.fn();
    const stateListener = vi.fn();

    await ticks();
    const first = client.changed.subscribe(listener);
    const second = client.changed.subscribe(listener);

    first(); first();
    exports.changed.emit({ amount: 1 });
    await ticks();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client.changed).not.toHaveProperty('unsubscribe');
    expect(client.current).not.toHaveProperty('unsubscribe');
    second();
    const third = client.changed.subscribe(listener);

    second();
    exports.changed.emit({ amount: 2 });
    const stopState = client.current.subscribe(stateListener);

    stopState();
    exports.current.set(3);
    await ticks();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(stateListener).not.toHaveBeenCalled();
    third();
    consumer.stop();
    owner.stop();
  });

  it('owns class-backed object references, forwards identity and releases their observable resources', async () => {
    const owner = runtime();
    const consumer = runtime();
    const receiver = runtime();
    const accountShape: ApiModuleShape = { kind: 'object', members: {
      balance: { kind: 'state', data: moneyData }, changed: { kind: 'event', data: moneyData },
      deposit: { kind: 'function', parameters: { items: [moneyData, { kind: 'callback', parameters: { items: [moneyData] } }] }, result: moneyData },
      owner: { kind: 'function' }, close: { kind: 'function' },
    } };
    const reference: ApiReferenceShape = { kind: 'reference', reference: 'api', contract: 'unit:account', shape: accountShape };

    class Account {
      readonly balance = observable<Money | undefined>(new Money(0));
      readonly changed = eventSource<Money>();
      constructor(private readonly host = owner) {}
      async deposit(value: Money, confirm: (value: Money) => Promise<boolean>): Promise<Money> {
        if (!await confirm(value)) { throw new Error('declined'); }

        const next = new Money((this.balance.get()?.gold ?? 0) + value.gold);

        this.balance.set(next);
        this.changed.emit(next);

        return next;
      }

      async owner(): Promise<string> { return this.host.namespace; }
      async close(): Promise<void> { this.host.api.release(this); }
    }
    const account = new Account();
    const factory = {
      async open(): Promise<Account> { return account; },
      async identity(value: Account): Promise<boolean> { return value === account; },
    };
    const factoryShape = { kind: 'object', members: {
      open: { kind: 'function', result: reference }, identity: { kind: 'function', parameters: { items: [reference] } },
    } } as const;
    const releaseFactory = owner.api.provideModule('@fixture/accounts', factoryShape, factory);

    owner.register({ manifest: manifest('accounts') });
    consumer.register({ manifest: manifest('consumer') });
    receiver.register({ manifest: manifest('receiver') });
    const client = consumer.api.createModule<typeof factory>('accounts', '@fixture/accounts', factoryShape);
    const opened = client.open();

    await ticks();
    const proxy = await opened;
    const again = client.open();

    await ticks();
    expect(await again).toBe(proxy);
    expect(proxy).not.toBe(account);
    expect(account.changed.size()).toBe(1);
    const balance = vi.fn();
    const changed = vi.fn();

    proxy.balance.subscribe(balance);
    proxy.changed.subscribe(changed);
    const deposited = proxy.deposit(new Money(3), async value => value.gold === 3);

    await ticks();
    expect(await deposited).toBeInstanceOf(Money);
    expect(proxy.balance.get()?.format()).toBe('3 gold');
    expect(changed).toHaveBeenCalledExactlyOnceWith(new Money(3));
    expect(() => consumer.api.release(proxy)).toThrow('owning addon');
    const identity = client.identity(proxy);

    await ticks();
    expect(await identity).toBe(true);
    const echoShape = { kind: 'object', members: { echo: { kind: 'function', parameters: { items: [reference] }, result: reference } } } as const;
    const echo = { async echo(value: Account): Promise<Account> {
      expect(['accounts', 'consumer']).toContain(await value.owner());

      return value;
    } };

    receiver.api.provideModule('@fixture/echo', echoShape, echo);
    const forward = consumer.api.createModule<typeof echo>('receiver', '@fixture/echo', echoShape).echo(proxy);

    await ticks();
    expect(await forward).toBe(proxy);
    const local = new Account(consumer);
    const reflected = consumer.api.createModule<typeof echo>('receiver', '@fixture/echo', echoShape).echo(local);

    await ticks();
    expect(await reflected).toBe(local);
    expect(consumer.api.release(local)).toBe(true);
    releaseFactory();
    const stillOwned = proxy.owner();

    await ticks();
    expect(await stillOwned).toBe('accounts');
    const closing = proxy.close();

    await ticks();
    await closing;
    expect(account.changed.size()).toBe(0);
    expect(proxy.balance.get()).toBeUndefined();
    expect(balance).toHaveBeenLastCalledWith(undefined, expect.any(Money));
    await expect(proxy.owner()).rejects.toThrow('unavailable');
    expect(owner.api.release(account)).toBe(false);
  });

  it('pins object references to the provider running instance across shutdown and replacement', async () => {
    const owner = runtime();
    const consumer = runtime();
    const reference = { kind: 'reference', reference: 'api', contract: 'unit:owner', shape: { kind: 'object', members: { owner: { kind: 'function' } } } } as const;
    const shape = { kind: 'object', members: { open: { kind: 'function', result: reference } } } as const;
    const factory = { async open(): Promise<{ owner(): Promise<string> }> { return { async owner(): Promise<string> { return 'first'; } }; } };

    owner.api.provideModule('@fixture/instances', shape, factory);
    owner.register({ manifest: manifest('provider') });
    consumer.register({ manifest: manifest('consumer') });
    const client = consumer.api.createModule<typeof factory>('provider', '@fixture/instances', shape);
    const opened = client.open();

    await ticks();
    const old = await opened;

    owner.stop();
    await ticks(360);
    const replacement = runtime();

    replacement.api.provideModule('@fixture/instances', shape, { async open(): Promise<{ owner(): Promise<string> }> { return { async owner(): Promise<string> { return 'second'; } }; } });
    replacement.register({ manifest: manifest('provider') });
    const renewed = client.open();

    await ticks();
    const fresh = await renewed;
    const called = fresh.owner();

    await ticks();
    expect(await called).toBe('second');
    expect(fresh).not.toBe(old);
    await expect(old.owner()).rejects.toThrow('unavailable');
  });

  it('rolls back nested object bindings when a parent subscription fails and permits a clean retry', async () => {
    const owner = runtime();
    const consumer = runtime();
    const child = { async owner(): Promise<string> { return owner.namespace; } };
    const childReference = { kind: 'reference', reference: 'api', contract: 'unit:child', shape: { kind: 'object', members: { owner: { kind: 'function' } } } } as const;
    const events = signal<number>();
    let broken = true;
    const source = { selected: observable<typeof child | undefined>(child), changed: { subscribe(listener: (value: number) => void): () => void {
      if (broken) { throw new Error('subscription failed'); }

      return events.subscribe(listener);
    } } };
    const parentReference = { kind: 'reference', reference: 'api', contract: 'unit:parent', shape: { kind: 'object', members: {
      selected: { kind: 'state', data: { ...childReference, missing: 'undefined' } }, changed: { kind: 'event' },
    } } } as const;
    const shape = { kind: 'object', members: { open: { kind: 'function', result: parentReference } } } as const;
    const factory = { async open(): Promise<typeof source> { return source; } };

    owner.api.provideModule('@fixture/rollback-objects', shape, factory);
    owner.register({ manifest: manifest('provider') });
    consumer.register({ manifest: manifest('consumer') });
    const client = consumer.api.createModule<typeof factory>('provider', '@fixture/rollback-objects', shape);
    const failed = expect(client.open()).rejects.toThrow('subscription failed');

    await ticks();
    await failed;
    broken = false;
    const opened = client.open();

    await ticks();
    const proxy = await opened;
    const called = proxy.selected.get()?.owner();

    await ticks();
    expect(await called).toBe('provider');
    expect(owner.registry.get('provider')?.apis).toEqual(['@fixture/rollback-objects']);
  });

  it('combines native entity references, value classes and callbacks through nested API bindings', async () => {
    const owner = runtime();
    const consumer = runtime();
    const entity = new engine.Entity('entity-1');
    const player = new engine.Player('player-1');
    const current = observable<{ entity: typeof entity | undefined; price: Money } | undefined>({ entity, price: new Money(2) });
    const dropped = signal<{ entity: typeof entity | undefined; price: Money }>();
    const entityData = { kind: 'reference', reference: 'entity' } as const;
    const optionalEntity = { kind: 'reference', reference: 'entity', missing: 'undefined' } as const;
    const itemData = { kind: 'object', members: { entity: optionalEntity, price: moneyData } } as const;
    const shape = { kind: 'object', members: { world: { kind: 'object', members: {
      current: { kind: 'state', data: itemData },
      afterEvents: { kind: 'object', members: { dropped: { kind: 'event', data: itemData } } },
      quote: { kind: 'function', parameters: { items: [entityData, { kind: 'callback', parameters: { items: [entityData, moneyData] }, result: moneyData }] }, result: itemData },
      playerId: { kind: 'function', parameters: { items: [{ kind: 'reference', reference: 'player' }] } },
    } } } } as const;
    const exports = { world: {
      current,
      afterEvents: { dropped },
      async quote(reference: typeof entity, confirm: (entity: typeof reference, price: Money) => Promise<Money>): Promise<{ entity: typeof entity; price: Money }> {
        expect(reference).toBe(entity);
        const price = await confirm(reference, new Money(3));
        const value = { entity: reference, price };

        current.set(value);
        dropped.emit(value);

        return value;
      },
      async playerId(reference: typeof player): Promise<string> { return reference.id; },
    } };

    engine.entities.set(entity.id, entity);
    engine.entities.set(player.id, player);
    owner.api.provideModule('@fixture/world', shape, exports);
    owner.register({ manifest: manifest('world') });
    consumer.register({ manifest: manifest('consumer') });
    const client = consumer.api.createModule<typeof exports>('world', '@fixture/world', shape);
    const received = vi.fn();

    client.world.afterEvents.dropped.subscribe(received);
    await ticks();
    const called = client.world.quote(entity, async (reference, price) => {
      expect(reference).toBe(entity);
      expect(price).toBeInstanceOf(Money);
      reference.addTag('callback');

      return new Money(price.gold + 1);
    });

    await ticks();
    expect(await called).toEqual({ entity, price: new Money(4) });
    expect(client.world.current.get()?.entity).toBe(entity);
    expect(client.world.current.get()?.price).toBeInstanceOf(Money);
    expect(Object.isFrozen(client.world.current.get())).toBe(true);
    expect(Object.isFrozen(client.world.current.get()?.price)).toBe(true);
    expect(Object.isFrozen(entity)).toBe(false);
    entity.addTag('after snapshot');
    expect(entity.tags.has('callback')).toBe(true);
    expect(received).toHaveBeenCalledExactlyOnceWith({ entity, price: new Money(4) });
    const playerCall = client.world.playerId(player);

    await ticks();
    expect(await playerCall).toBe(player.id);
    await expect(client.world.playerId(entity)).rejects.toThrow('expected a Minecraft player');
    owner.stop();
    expect(entity.isValid).toBe(true);
  });

  it('rejects unresolved required references before invoking the provider and preserves optional event data', async () => {
    const owner = runtime();
    const consumer = runtime();
    const entity = new engine.Entity('removed-entity');
    const optional = { kind: 'reference', reference: 'entity', missing: 'undefined' } as const;
    const dropped = signal<{ id: string; entity: typeof entity | undefined }>();
    const track = vi.fn(async (_entity: typeof entity): Promise<void> => undefined);
    const shape = { kind: 'object', members: {
      track: { kind: 'function', parameters: { items: [{ kind: 'reference', reference: 'entity' }] } },
      dropped: { kind: 'event', data: { kind: 'object', members: { entity: optional } } },
    } } as const;

    engine.entities.set(entity.id, entity);
    owner.api.provideModule('@fixture/reference-lifetime', shape, { track, dropped });
    owner.register({ manifest: manifest('world') });
    consumer.register({ manifest: manifest('consumer') });
    const client = consumer.api.createModule<{ track: typeof track; dropped: typeof dropped }>('world', '@fixture/reference-lifetime', shape);
    const received = vi.fn();

    client.dropped.subscribe(received);
    await ticks();
    const called = client.track(entity);
    const failed = expect(called).rejects.toThrow('unavailable');

    dropped.emit({ id: entity.id, entity });
    engine.entities.delete(entity.id);
    entity.isValid = false;
    await ticks();
    await failed;
    expect(track).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledExactlyOnceWith({ id: entity.id, entity: undefined });
  });

  it('keeps local API snapshots and events isolated from the authored mutable data', async () => {
    const owner = runtime();
    const stateValue = { gold: 2 };
    const eventValue = { gold: 3 };
    const state = observable(stateValue);
    const changed = signal<{ gold: number }>();
    const shape = { kind: 'object', members: { state: { kind: 'state' }, changed: { kind: 'event' } } } as const;

    owner.api.provideModule('@fixture/local', shape, { state, changed });
    owner.register({ manifest: manifest('local') });
    const api = owner.api.createModule<{ state: typeof state; changed: typeof changed }>('local', '@fixture/local', shape);
    const listener = vi.fn();

    api.changed.subscribe(listener);
    expect(api.state.get()).toEqual(stateValue);
    expect(api.state.get()).not.toBe(stateValue);
    expect(Object.isFrozen(api.state.get())).toBe(true);
    expect(Object.isFrozen(stateValue)).toBe(false);
    changed.emit(eventValue);
    expect(listener).toHaveBeenCalledExactlyOnceWith(eventValue);
    expect(Object.isFrozen(listener.mock.calls[0][0])).toBe(true);
    expect(Object.isFrozen(eventValue)).toBe(false);
    await ticks();
  });

  it('imports before registration without engine work and rejects an operation until registration', async () => {
    const client = createApiModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);

    expect(client.info.currency).toBe('Gold');
    expect(client.current.get()).toBeUndefined();
    expect(client.current).not.toHaveProperty('set');
    expect(client.changed).not.toHaveProperty('emit');
    expect(engine.tasks.size).toBe(0);
    expect(engine.listeners.size).toBe(0);
    await expect(client.sum(1, 2)).rejects.toThrow(/register/);
  });

  it('connects queued singleton provider bindings to core on registration', async () => {
    const exports = source();
    const release = provideApiModule('@fixture/economy', shape, exports);
    const consumer = runtime();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);

    expect(exports.changed.size()).toBe(0);
    core.register({ manifest: manifest('economy') });
    consumer.register({ manifest: manifest('shop') });
    await ticks();

    const result = client.sum(2, 3, ' coins');

    await ticks();
    expect(await result).toBe('5 coins');
    release();
    release();
    await ticks();
    expect(client.current.get()).toBeUndefined();
    expect(exports.changed.size()).toBe(0);
  });

  it('waits for a later provider and retains pre-registration state listeners', async () => {
    const consumer = runtime();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const changes: unknown[] = [];

    client.current.subscribe((next, prev) => changes.push([next, prev]));
    consumer.register({ manifest: manifest('shop') });

    const result = client.sum(3, 4);

    await ticks(10);

    const owner = runtime();

    owner.api.provideModule('@fixture/economy', shape, source());
    owner.register({ manifest: manifest('economy') });
    await ticks();
    expect(await result).toBe('7G');
    expect(client.current.get()).toBe(2);
    expect(changes).toEqual([[2, undefined]]);
  });

  it('replicates snapshots to a late consumer and sends owner-only events without replay', async () => {
    const owner = runtime();
    const exports = source();

    owner.register({ manifest: manifest('economy') });
    owner.api.provideModule('@fixture/economy', shape, exports);
    exports.changed.emit({ amount: 1 });
    await ticks();

    const consumer = runtime();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const events: unknown[] = [];

    client.changed.subscribe(payload => events.push(payload));
    consumer.register({ manifest: manifest('shop') });
    await ticks();
    expect(client.current.get()).toBe(2);
    expect(events).toEqual([]);

    exports.current.set(8);
    exports.changed.emit({ amount: 8 });
    await ticks();
    expect(client.current.get()).toBe(8);
    expect(events).toEqual([{ amount: 8 }]);
  });

  it('preserves undefined call arguments and uses JSON data for results and large payloads', async () => {
    const { consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const called = vi.spyOn(exports, 'echo');

    await ticks();

    const payload = { optional: undefined, nested: [null, undefined, 'x'.repeat(12000)] };
    const result = client.echo('first', undefined, 3, payload, -0);
    const empty = client.empty();

    await ticks(15);

    const echoed = await result;

    const copied = { nested: [null, null, 'x'.repeat(12000)] };

    expect(called).toHaveBeenCalledWith('first', undefined, 3, copied, 0);
    expect(echoed).toEqual(['first', null, 3, copied, 0]);
    const optional = echoed[3];

    expect(optional !== null && typeof optional === 'object' && Object.hasOwn(optional, 'optional')).toBe(false);
    expect(await empty).toBeUndefined();
    expect(engine.messages.every(message => message.length <= MAX_MESSAGE)).toBe(true);
  });

  it('preserves defaults, null arguments, rest positions and argument count locally and remotely', async () => {
    const { owner, consumer } = pair();
    const exports = {
      async inspect(first = 'default', second: string | null = 'second', ...rest: unknown[]): Promise<unknown> {
        return { first, second, rest: rest.map(value => value === undefined ? 'missing' : value), count: arguments.length };
      },
    };
    const moduleShape = { kind: 'object', members: { inspect: { kind: 'function' } } } as const;

    owner.api.provideModule('@fixture/defaults', moduleShape, exports);
    await ticks();

    const pending = [owner, consumer].flatMap((runtime) => {
      const client = runtime.api.createModule<typeof exports>('economy', '@fixture/defaults', moduleShape);

      return [client.inspect(undefined, null, undefined, 'last', undefined), client.inspect()];
    });

    await ticks();
    expect(await Promise.all(pending)).toEqual([
      { first: 'default', second: null, rest: ['missing', 'last', 'missing'], count: 5 },
      { first: 'default', second: 'second', rest: [], count: 0 },
      { first: 'default', second: null, rest: ['missing', 'last', 'missing'], count: 5 },
      { first: 'default', second: 'second', rest: [], count: 0 },
    ]);
  });

  it('reconstructs value classes in nested calls, snapshots and signals with stable snapshot identity', async () => {
    const { owner, consumer } = pair();
    const current = observable<Money | undefined>(new Money(2));
    const changed = signal<{ price: Money }>();
    const exports = {
      Money,
      current,
      changed,
      async quote(value: { prices: Money[]; pair: [Money, string] }): Promise<{ price: Money; text: string }> {
        expect(value.prices[0]).toBeInstanceOf(Money);
        expect(value.pair[0].format()).toBe('5 gold');

        return { price: new Money(value.prices[0].gold + value.pair[0].gold), text: value.pair[1] };
      },
    };
    const moduleShape = {
      kind: 'object',
      members: {
        Money: { kind: 'local', value: Money },
        current: { kind: 'state', data: moneyData },
        changed: { kind: 'event', data: { kind: 'object', members: { price: moneyData } } },
        quote: {
          kind: 'function',
          parameters: { items: [{ kind: 'object', members: {
            prices: { kind: 'array', item: moneyData },
            pair: { kind: 'tuple', items: [moneyData] },
          } }] },
          result: { kind: 'object', members: { price: moneyData } },
        },
      },
    } as const satisfies ApiModuleShape;

    owner.api.provideModule('@fixture/values', moduleShape, exports);
    const client = consumer.api.createModule<typeof exports>('economy', '@fixture/values', moduleShape);

    await ticks();
    expect(client.Money).toBe(Money);
    expect(client.current.get()?.format()).toBe('2 gold');
    expect(client.current.get()).toBe(client.current.get());
    expect(Object.isFrozen(current.get())).toBe(false);
    const updates: string[] = [];
    const events: string[] = [];
    const stopState = client.current.subscribe(value => updates.push(value?.format() ?? 'missing'));
    const stopEvent = client.changed.subscribe(value => events.push(value.price.format()));
    const quoted = client.quote({ prices: [new Money(3)], pair: [new Money(5), 'quote'] });

    current.set(new Money(4));
    changed.emit({ price: new Money(6) });
    await ticks();
    expect((await quoted).price.format()).toBe('8 gold');
    expect(updates).toEqual(['4 gold']);
    expect(events).toEqual(['6 gold']);
    stopState();
    stopEvent();
  });

  it('runs call-scoped callbacks in their owner with value classes, defaults and rest arguments', async () => {
    const { owner, consumer } = pair();
    let retained: ((value: Money, note?: string, ...rest: Money[]) => Promise<Money>) | undefined;
    const exports = {
      async purchase(confirm: (value: Money, note?: string, ...rest: Money[]) => Promise<Money>): Promise<Money> {
        retained = confirm;

        return confirm(new Money(5), undefined, new Money(2), new Money(3));
      },
    };
    const callback = {
      kind: 'callback', parameters: { items: [moneyData], rest: moneyData }, result: moneyData,
    } as const;
    const moduleShape = { kind: 'object', members: { purchase: {
      kind: 'function', parameters: { items: [callback] }, result: moneyData,
    } } } as const satisfies ApiModuleShape;
    // The ordinary note argument precedes the homogeneous rest values.
    const shape = { ...moduleShape, members: { purchase: { ...moduleShape.members.purchase,
      parameters: { items: [{ ...callback, parameters: { items: [moneyData, null], rest: moneyData } }] },
    } } } as const;

    owner.api.provideModule('@fixture/callback', shape, exports);
    await ticks();
    const callbackOwner = vi.fn(async (price: Money, note = 'default', ...rest: Money[]): Promise<Money> => {
      expect(price.format()).toBe('5 gold');
      expect(note).toBe('default');

      return new Money(price.gold + rest.reduce((sum, value) => sum + value.gold, 0));
    });
    const client = consumer.api.createModule<typeof exports>('economy', '@fixture/callback', shape);
    const result = client.purchase(callbackOwner);

    await ticks(15);
    expect((await result).format()).toBe('10 gold');
    expect(callbackOwner).toHaveBeenCalledTimes(1);
    await expect(retained?.(new Money(1))).rejects.toThrow(/call has ended/);
    const again = client.purchase(callbackOwner);

    await ticks(15);
    expect((await again).gold).toBe(10);
  });

  it('cleans callback handlers after rejection, timeout, withdrawal and runtime shutdown', async () => {
    const { owner, consumer } = pair();
    let retained: (() => Promise<void>) | undefined;
    let finish: (() => void) | undefined;
    const exports = {
      async run(callback: () => Promise<void>, mode: string): Promise<void> {
        retained = callback;

        if (mode === 'reject') {
          await callback();

          return;
        }

        await new Promise<void>((resolve) => { finish = resolve; });
      },
    };
    const shape = { kind: 'object', members: { run: { kind: 'function', parameters: { items: [{ kind: 'callback' }] } } } } as const;
    const withdraw = owner.api.provideModule('@fixture/scoped', shape, exports);

    await ticks();
    const client = consumer.api.createModule<typeof exports>('economy', '@fixture/scoped', shape);
    const failing = expect(client.run(async () => { throw new Error('decision failed'); }, 'reject')).rejects.toThrow('decision failed');

    await ticks(15);
    await failing;
    await expect(retained?.()).rejects.toThrow(/call has ended/);
    const expired = expect(client.run(async () => {}, 'wait')).rejects.toThrow(/timed out/);

    await ticks(110);
    await expired;
    await expect(retained?.()).rejects.toThrow(/call has ended/);
    finish?.();
    await ticks();
    const waiting = expect(client.run(async () => {}, 'wait')).rejects.toThrow(/provider stopped/);

    await ticks();
    withdraw();
    await expect(retained?.()).rejects.toThrow(/call has ended/);
    finish?.();
    await ticks();
    await waiting;
    const withdrawNext = owner.api.provideModule('@fixture/scoped', shape, exports);

    await ticks();
    const stopped = expect(client.run(async () => {}, 'wait')).rejects.toThrow(/RPC stopped/);

    await ticks();
    consumer.stop();
    await stopped;
    withdrawNext();
    finish?.();
    await ticks();
  });

  it('routes declared exports and uses one RPC error response', async () => {
    const { consumer, exports } = pair();
    const sum = vi.spyOn(exports, 'sum');
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const subset = consumer.api.createModule<{ sum: typeof exports.sum }>('economy', '@fixture/economy', {
      kind: 'object', members: { sum: { kind: 'function' } },
    });
    const missing = consumer.api.createModule<{ missing(): Promise<void> }>('economy', '@fixture/economy', {
      kind: 'object', members: { missing: { kind: 'function' } },
    });

    await ticks();
    expect(consumer.registry.get('economy')?.apis).toEqual(['@fixture/economy']);
    const result = subset.sum(1, 2);

    await ticks();
    expect(await result).toBe('3G');
    expect(sum).toHaveBeenCalledTimes(1);
    const unknown = expect(missing.missing()).rejects.toThrow(/unknown method/);

    await ticks();
    await unknown;
    expect(sum).toHaveBeenCalledTimes(1);
    const failure = expect(client.fail()).rejects.toThrow('insufficient funds');

    await ticks();
    await failure;
    const responses = engine.messages.flatMap((message) => {
      const wire = decodeWire(message);

      return wire?.kind === 'envelopes' ? wire.envelopes : [];
    }).filter(envelope => envelope.src === 'economy' && envelope.type === 'res');

    expect(responses.some(({ data }) => typeof data === 'object' && data !== null
      && 'ok' in data && data.ok === false && 'err' in data && data.err === 'insufficient funds')).toBe(true);
  });

  it('bounds startup waits for missing owners and existing owners without the module', async () => {
    const { consumer } = pair();
    const missing = consumer.api.createModule<ReturnType<typeof source>>('missing', '@fixture/economy', shape);
    const unbound = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/other', shape);
    const absent = expect(missing.sum(1, 2)).rejects.toThrow(/unavailable after 100 ticks/);
    const notBound = expect(unbound.sum(1, 2)).rejects.toThrow(/unavailable after 100 ticks/);

    await ticks(101);
    await absent;
    await notBound;
  });

  it('bounds an unanswered function call without blocking other calls', async () => {
    const { consumer } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);

    await ticks();

    const timedOut = expect(client.never()).rejects.toThrow(/timed out/);
    const available = client.sum(1, 9);

    await ticks(103);
    await timedOut;
    expect(await available).toBe('10G');
  });

  it('withdraws snapshots and bridges on unbind; rebinding uses the new snapshot', async () => {
    const { owner, consumer, exports, release } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const changes: unknown[] = [];
    const events: unknown[] = [];

    client.current.subscribe((next, prev) => changes.push([next, prev]));
    client.changed.subscribe(payload => events.push(payload));
    await ticks();
    release();
    release();
    exports.current.set(9);
    exports.changed.emit({ amount: 9 });
    await ticks();
    expect(client.current.get()).toBeUndefined();
    expect(changes).toEqual([[2, undefined], [undefined, 2]]);
    expect(events).toEqual([]);
    expect(exports.changed.size()).toBe(0);

    const next = source();

    next.current.set(15);
    owner.api.provideModule('@fixture/economy', shape, next);
    await ticks();
    expect(client.current.get()).toBe(15);
  });

  it('invalidates a stopped provider at discovery expiry and accepts a replacement owner', async () => {
    const { owner, consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);

    await ticks();

    for (let i = 3; i < 60; i++) { exports.current.set(i); }

    await ticks();
    expect(client.current.get()).toBe(59);
    const stale = engine.messages.flatMap((message) => {
      const wire = decodeWire(message);

      return wire?.kind === 'envelopes' ? wire.envelopes : [];
    }).findLast(envelope => envelope.src === 'economy' && envelope.type === MessageType.StateDelta);

    owner.stop();
    await ticks(360);
    expect(consumer.registry.has('economy')).toBe(false);
    expect(client.current.get()).toBeUndefined();

    const replacement = runtime();
    const next = source();

    next.current.set(1);
    replacement.api.provideModule('@fixture/economy', shape, next);
    replacement.register({ manifest: manifest('economy') });
    await ticks();
    expect(client.current.get()).toBe(1);

    if (stale === undefined || stale.data === null || typeof stale.data !== 'object') { throw new Error('missing old state update'); }

    const message = encodeBatch([encodeEnvelope({ ...stale, data: { ...stale.data, value: 999, ver: 1000000 } })]);

    for (const listener of engine.listeners) { listener({ id: BUS_CHANNEL, message }); }

    await ticks();
    expect(client.current.get()).toBe(1);
  });

  it('cleans startup waits, RPC calls and subscriptions immediately when the consumer stops', async () => {
    const { consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const changes = vi.fn();
    const events = vi.fn();
    const releaseState = client.current.subscribe(changes);
    const releaseEvent = client.changed.subscribe(events);

    await ticks();

    const waitingClient = consumer.api.createModule<ReturnType<typeof source>>('missing', '@fixture/economy', shape);
    const waiting = expect(waitingClient.sum(1, 2)).rejects.toThrow(/runtime stopped/);
    const active = expect(client.never()).rejects.toThrow(/RPC stopped/);

    await ticks(3);
    consumer.stop();
    await waiting;
    await active;
    changes.mockClear();
    consumer.register({ manifest: manifest('shop') });
    exports.current.set(20);
    exports.changed.emit({ amount: 20 });
    await ticks();
    expect(changes).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    releaseState();
    releaseState();
    releaseEvent();
    releaseEvent();
  });

  it('rejects JSON serialization failures before RPC and returns result serialization errors', async () => {
    const { consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const called = vi.spyOn(exports, 'echo');
    const cycle: Record<string, unknown> = {};

    cycle.self = cycle;
    await ticks();

    for (const unsupported of [BigInt(2), cycle]) {
      await expect(client.echo(unsupported)).rejects.toThrow();
    }

    expect(called).not.toHaveBeenCalled();
    called.mockResolvedValue([BigInt(1)]);

    const rejected = expect(client.echo()).rejects.toThrow(/JSON|BigInt|bigint/i);

    await ticks();
    await rejected;
  });

  it('rejects invalid initial state and withdraws unsupported later snapshots', async () => {
    const { owner, consumer, exports } = pair();
    const invalid = source();

    Object.defineProperty(invalid, 'current', { value: observable(BigInt(1)) });
    expect(() => owner.api.provideModule('@fixture/invalid', shape, invalid)).toThrow();

    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);

    await ticks();

    // The provider's transport guard still runs when JavaScript bypasses TypeScript's source value type.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Reflect.apply(exports.current.set, exports.current, [BigInt(1)]);
    await ticks();
    expect(client.current.get()).toBeUndefined();
  });

  it('keeps event ownership even when another addon emits a copied transport payload', async () => {
    const { consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const listener = vi.fn();

    client.changed.subscribe(listener);
    await ticks();
    exports.changed.emit({ amount: 5 });
    await ticks();

    const event = engine.messages.flatMap((message) => {
      const wire = decodeWire(message);

      return wire?.kind === 'envelopes' ? wire.envelopes : [];
    }).find(envelope => envelope.src === 'economy' && envelope.type === 'event');
    const data = event?.data;

    if (typeof data !== 'object' || data === null || !('n' in data) || typeof data.n !== 'string' || !('p' in data)) {
      throw new Error('expected a real provider event on the bus');
    }

    const foreign = new SyncNode({ id: 'foreign' });

    syncNodes.push(foreign);
    foreign.start();
    foreign.events.emit(data.n, data.p);
    await ticks();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('delivers explicit undefined snapshots/events and releases live listeners idempotently', async () => {
    const owner = runtime();
    const consumer = runtime();
    const state = observable<string | undefined>('first');
    const event = eventSource<string | undefined>();
    const exports = { state, event };
    const optionalShape = {
      kind: 'object',
      members: { state: { kind: 'state' }, event: { kind: 'event' } },
    } as const;

    owner.api.provideModule('@fixture/optional', optionalShape, exports);
    owner.register({ manifest: manifest('economy') });
    consumer.register({ manifest: manifest('shop') });

    const client = consumer.api.createModule<typeof exports>('economy', '@fixture/optional', optionalShape);

    await ticks();

    const changed = vi.fn();
    const happened = vi.fn();
    const releaseState = client.state.subscribe(changed);
    const releaseEvent = client.event.subscribe(happened);

    expect(changed).not.toHaveBeenCalled();
    state.set(undefined);
    event.emit(undefined);
    await ticks();
    expect(client.state.get()).toBeUndefined();
    expect(changed).toHaveBeenCalledExactlyOnceWith(undefined, 'first');
    expect(happened).toHaveBeenCalledExactlyOnceWith(undefined);
    releaseState();
    releaseState();
    releaseEvent();
    releaseEvent();
    state.set('last');
    event.emit('last');
    await ticks();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(happened).toHaveBeenCalledTimes(1);
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    Reflect.apply(event.emit, event, [BigInt(1)]);
    expect(report).toHaveBeenCalledWith('[observable] signal: listener threw', expect.objectContaining({ message: expect.stringMatching(/JSON|BigInt|bigint/i) }));
  });

  it('rolls back registration when a queued provider has invalid initial data', () => {
    const owner = runtime();
    const invalid = source();

    Object.defineProperty(invalid, 'current', { value: observable(BigInt(1)) });
    owner.api.provideModule('@fixture/economy', shape, invalid);
    expect(() => owner.register({ manifest: manifest('economy') })).toThrow();
    expect(owner.registered).toBe(false);
    expect(engine.listeners.size).toBe(0);
    expect(engine.tasks.size).toBe(0);
  });

  it('routes nested function, state and event members without losing their receiver or paths', async () => {
    const owner = runtime();
    const consumer = runtime();
    const exports = {
      nested: {
        unit: 'G',
        async format(left: number, right: number): Promise<string> { return `${left + right}${this.unit}`; },
        current: observable({ gold: 3 }),
        changed: eventSource<{ gold: number }>(),
      },
    };
    const nestedShape = {
      kind: 'object',
      members: {
        nested: {
          kind: 'object',
          members: {
            unit: { kind: 'value', value: 'G' },
            format: { kind: 'function' },
            current: { kind: 'state' },
            changed: { kind: 'event' },
          },
        },
      },
    } as const;

    owner.api.provideModule('@fixture/nested', nestedShape, exports);
    owner.register({ manifest: manifest('economy') });
    consumer.register({ manifest: manifest('shop') });

    const client = consumer.api.createModule<typeof exports>('economy', '@fixture/nested', nestedShape);
    const happened = vi.fn();

    client.nested.changed.subscribe(happened);
    await ticks();

    const result = client.nested.format(2, 3);

    exports.nested.changed.emit({ gold: 4 });
    await ticks();
    expect(await result).toBe('5G');
    expect(client.nested.current.get()).toEqual({ gold: 3 });
    expect(Object.isFrozen(client.nested.current.get())).toBe(true);
    expect(happened).toHaveBeenCalledExactlyOnceWith({ gold: 4 });
  });

  it('owns lazy declarations through install and tears them down in reverse order', () => {
    const owner = runtime();
    const order: string[] = [];

    expect(() => owner.install({ install: (): number => 1 })).toThrow(/register/);
    const registered = owner.register({
      manifest: manifest('economy'),
      first: { install: (): number => {
        order.push('first');

        return 1;
      }, stop: (): void => { order.push('stop first'); } },
    });

    expect(registered.first).toBe(1);
    expect(owner.install({ install: (): number => {
      order.push('second');

      return 2;
    }, stop: (): void => { order.push('stop second'); } })).toBe(2);
    owner.stop();
    owner.stop();
    expect(order).toEqual(['first', 'second', 'stop second', 'stop first']);
    expect(owner).not.toHaveProperty('rpc');
    expect(owner).not.toHaveProperty('node');
    expect(owner).not.toHaveProperty('shared');
    expect(owner).not.toHaveProperty('events');
    expect(Object.keys(owner.api).sort()).toEqual(['createModule', 'of', 'provideModule', 'release']);
    expect(owner.api).not.toHaveProperty('start');
    expect(owner.api).not.toHaveProperty('stop');
    expect(owner.api).not.toHaveProperty('_backend');
    expect(Object.isFrozen(owner.api)).toBe(true);
    expect(owner.api).toBe(owner.api);
  });

  it('tracks cleanup for a partially installed declaration', () => {
    const owner = runtime();
    const release = vi.fn();

    owner.register({ manifest: manifest('economy') });
    expect(() => owner.install({ install: (): never => { throw new Error('incomplete install'); }, stop: release })).toThrow('incomplete install');
    owner.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('owns an optional integration driven by local configuration and a live peer observable', async () => {
    const consumer = runtime();
    const configured = observable(true);
    const events = eventSource<number>();
    const received = vi.fn();
    const moduleShape = { kind: 'object', members: { accepting: { kind: 'state' } } } as const;
    const client = consumer.api.createModule<{ accepting: ReadonlyObservable<boolean | undefined> }>('leaderboard', '@fixture/leaderboard', moduleShape);

    let dispose = (): void => {};

    consumer.register({
      manifest: manifest('shop'),
      integration: {
        install(): void {
          const enabled = computed(() => configured.get() && client.accepting.get() === true, [configured, client.accepting]);

          let disconnect = (): void => {};

          const stopEffect = effect(() => {
            disconnect();

            disconnect = enabled.get() ? events.subscribe(received) : (): void => {};
          }, [enabled]);

          dispose = (): void => { stopEffect(); disconnect(); enabled.dispose(); };
        },
        stop(): void { dispose(); },
      },
    });
    expect(events.size()).toBe(0);

    const accepting = observable<boolean | undefined>(true);
    const owner = runtime();

    owner.api.provideModule('@fixture/leaderboard', moduleShape, { accepting });
    owner.register({ manifest: manifest('leaderboard') });
    await ticks();
    expect(events.size()).toBe(1);
    events.emit(1);
    expect(received).toHaveBeenLastCalledWith(1);
    configured.set(false);
    expect(events.size()).toBe(0);
    configured.set(true);
    expect(events.size()).toBe(1);
    accepting.set(false);
    await ticks();
    expect(events.size()).toBe(0);
    accepting.set(true);
    await ticks();
    expect(events.size()).toBe(1);
    owner.stop();
    await ticks(360);
    expect(events.size()).toBe(0);

    const restarted = runtime();

    restarted.api.provideModule('@fixture/leaderboard', moduleShape, { accepting });
    restarted.register({ manifest: manifest('leaderboard') });
    await ticks();
    expect(events.size()).toBe(1);
    consumer.stop();
    consumer.stop();
    expect(events.size()).toBe(0);
    configured.set(false);
    configured.set(true);
    events.emit(2);
    expect(events.size()).toBe(0);
    expect(received).toHaveBeenCalledTimes(1);
    expect(consumer).not.toHaveProperty('features');
  });

  it('preserves Object.keys order in authored function arguments and results across the real bus', async () => {
    const owner = runtime();
    const consumer = runtime();
    const seen: string[][] = [];
    const exports = {
      async inspect(value: { z: number; a: undefined; nested: { last: undefined; first: number } }): Promise<{ z: number; a: undefined; nested: { last: undefined; first: number } }> {
        seen.push(Object.keys(value), Object.keys(value.nested));

        return { z: 2, a: undefined, nested: { last: undefined, first: 3 } };
      },
    };
    const shape = { kind: 'object', members: { inspect: { kind: 'function' } } } as const;

    owner.api.provideModule('@fixture/ordered', shape, exports);
    owner.register({ manifest: manifest('economy') });
    consumer.register({ manifest: manifest('shop') });

    const client = consumer.api.createModule<typeof exports>('economy', '@fixture/ordered', shape);
    const called = client.inspect({ z: 1, a: undefined, nested: { last: undefined, first: 2 } });

    await ticks();

    const result = await called;

    expect(seen).toEqual([['z', 'nested'], ['first']]);
    expect(Object.keys(result)).toEqual(['z', 'nested']);
    expect(Object.keys(result.nested)).toEqual(['first']);
    expect(Object.hasOwn(result, 'a')).toBe(false);
    expect(Object.hasOwn(result.nested, 'last')).toBe(false);
  });
  it('rolls back every declaration and transport after registration fails', () => {
    const owner = runtime();
    const first = vi.fn();
    const failed = vi.fn();

    expect(() => owner.register({
      manifest: manifest('rollback'),
      first: { install(): void {}, stop: first },
      failed: { install(): never { throw new Error('install failed'); }, stop: failed },
    })).toThrow('install failed');
    expect(first).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(owner.registered).toBe(false);
    expect(engine.listeners.size).toBe(0);
    expect(engine.tasks.size).toBe(0);
    owner.register({ manifest: manifest('restarted') });
    expect(owner.id).toBe('restarted');
  });

  it('finishes teardown and resets identity when declaration cleanup throws', () => {
    const owner = runtime();
    const earlier = vi.fn();

    owner.register({
      manifest: manifest('cleanup'),
      earlier: { install(): void {}, stop: earlier },
      broken: { install(): void {}, stop(): void { owner.stop(); throw new Error('cleanup failure'); } },
    });
    const database = vi.spyOn(owner.db, 'stop');
    const registry = vi.spyOn(owner.registry, 'stop');

    expect(() => owner.stop()).toThrow(AggregateError);
    expect(earlier).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledTimes(1);
    expect(registry).toHaveBeenCalledTimes(1);
    expect(owner.registered).toBe(false);
    expect(engine.tasks.size).toBe(0);
    expect(engine.listeners.size).toBe(0);
    expect(() => owner.stop()).not.toThrow();
  });

  it('isolates registry listeners for initial and later dependency availability', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = runtime();
    const dependency = runtime();

    owner.register({
      manifest: {
        ...manifest('waiting'),
        dependencies: [{ namespace: 'dependency', uuid: '0cc706ca-f07e-4d0a-aa85-7db177b0d2d1', version: '1.0.0' }],
      },
    });
    owner.registry.onDependenciesSatisfied(() => { throw new Error('listener failed'); });
    const later = vi.fn();

    owner.registry.onDependenciesSatisfied(later);
    dependency.register({ manifest: manifest('dependency') });
    await ticks();
    expect(later).toHaveBeenCalledTimes(1);
    expect(() => owner.registry.onDependenciesSatisfied(() => { throw new Error('initial failed'); })).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
  it('uses standard observable batching and error isolation for peer snapshots', async () => {
    const { owner, consumer, exports } = pair();
    const client = consumer.api.createModule<ReturnType<typeof source>>('economy', '@fixture/economy', shape);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const later = vi.fn();

    client.current.subscribe(() => { throw new Error('listener failed'); });
    client.current.subscribe(later);
    await ticks();
    later.mockClear();
    error.mockClear();
    batch(() => {
      exports.current.set(4);
      exports.current.set(5);
    });
    await ticks();
    expect(client.current.get()).toBe(5);
    expect(later).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    owner.stop();
    consumer.stop();
  });
});
