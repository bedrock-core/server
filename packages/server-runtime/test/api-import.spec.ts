import { describe, expect, it, vi } from 'vitest';

vi.mock('@minecraft/server', () => { throw new Error('API helper imports must not load Minecraft'); });

const bindings = await import('../src/api');
const { createApiModule, provideApiModule } = bindings;

describe('API bindings in a build-time evaluator', () => {
  it('materializes immutable manifest metadata without loading or registering a runtime', () => {
    expect(Object.keys(bindings).sort()).toEqual(['createApiModule', 'defineApiDeclaration', 'defineApiModule', 'provideApiModule']);
    const metadata = { namespace: 'economy', header: { version: '1.0.0' }, fields: [1, null, undefined] } as const;
    const client = createApiModule<{ default: typeof metadata }>('economy', '@fixture/economy/manifest.json', {
      kind: 'object', members: { default: { kind: 'value', value: metadata } },
    });

    expect(client.default).toEqual({ namespace: 'economy', header: { version: '1.0.0' }, fields: [1, null, null] });
    expect(Object.isFrozen(client.default)).toBe(true);
    expect(Object.isFrozen(client.default.header)).toBe(true);
    expect(Object.isFrozen(client.default.fields)).toBe(true);
  });

  it('queues subscriptions and provider bindings inertly and releases them without attachment', async () => {
    const shape = {
      kind: 'object',
      members: { call: { kind: 'function' }, value: { kind: 'state' } },
    } as const;
    const get = vi.fn((): number => { throw new Error('provider value must not be read before registration'); });
    const subscribe = vi.fn((): (() => void) => { throw new Error('provider subscription must not attach before registration'); });
    const releaseProvider = provideApiModule('@fixture/economy', shape, { call: async (): Promise<void> => undefined, value: { get, subscribe } });
    const client = createApiModule<{ call(): Promise<void>; value: { get(): number; subscribe(listener: (value: number) => void): () => void } }>('economy', '@fixture/economy', shape);
    const listener = vi.fn();
    const releaseListener = client.value.subscribe(listener);

    expect(client.value.get()).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    await expect(client.call()).rejects.toThrow(/register/);

    releaseProvider();
    releaseProvider();
    releaseListener();
    releaseListener();
    expect(listener).not.toHaveBeenCalled();
  });
});
