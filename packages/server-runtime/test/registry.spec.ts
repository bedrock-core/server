import { observable, type Observable, type Unsubscribe } from '@bedrock-core/observable';
import type { Discovery, IncompatiblePeer, PeerInfo } from '@bedrock-core/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddonManifest } from '../src/manifest';

vi.mock('@minecraft/server', () => ({ system: {} }));

const { AddonRegistry } = await import('../src/registries/addons');

const manifest = {
  format_version: 3,
  namespace: 'consumer',
  header: { name: 'Consumer', version: '1.0.0' },
  modules: [{ type: 'script' }],
  dependencies: [{ uuid: 'provider-uuid', version: '1.0.0', namespace: 'core_peer' }],
} satisfies AddonManifest;

function fixture(): {
  registry: InstanceType<typeof AddonRegistry>;
  incompatible: Observable<readonly IncompatiblePeer[]>;
  peers: Observable<readonly PeerInfo[]>;
} {
  const incompatible = observable<readonly IncompatiblePeer[]>([]);
  const discovery = {
    peers: observable<readonly PeerInfo[]>([]),
    incompatiblePeers: incompatible,
    onCollision: (): Unsubscribe => (): void => { /* this fixture emits only peer advertisements */ },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expose only the discovery members the registry observes
  const registry = new AddonRegistry(discovery as unknown as Discovery, manifest);

  registry.start();

  return { registry, incompatible, peers: discovery.peers };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('registered addon manifests', () => {
  const provider: AddonManifest = {
    format_version: 3,
    namespace: 'core_peer',
    header: { name: 'pack.name', description: 'pack.description', version: '2.0.0', uuid: 'provider-uuid' },
    metadata: { authors: ['Author'], license: 'MIT' },
    modules: [{ type: 'script', entry: 'scripts/main.js' }],
    thumbnail: 'textures/core_peer/thumbnail',
  };
  const peer = (input: unknown, identity = 'core_peer', version = '2.0.0'): PeerInfo => ({
    id: identity, instanceId: 'provider-instance', version, schemaVersion: 0, protocol: 1, caps: [],
    meta: { manifest: input, runtimeVersion: '1.0.0', apis: ['@fixture/provider'] },
  });

  it('keeps native manifest fields on local and remote entries and derives dependency availability', () => {
    const { registry, peers } = fixture();

    expect(registry.get('consumer')?.manifest).toBe(manifest);
    expect(registry.missingDependencies()).toEqual(['core_peer']);
    peers.set([peer(provider)]);
    const remote = registry.get('core_peer');

    expect(remote?.manifest).toEqual(provider);
    expect(remote?.manifest.header.name).toBe('pack.name');
    expect(remote?.manifest.header.description).toBe('pack.description');
    expect(remote?.apis).toEqual(['@fixture/provider']);
    expect(remote).not.toHaveProperty('packName');
    expect(remote).not.toHaveProperty('authors');
    expect(registry.missingDependencies()).toEqual([]);
    peers.set([]);
    expect(registry.missingDependencies()).toEqual(['core_peer']);
    registry.stop();
  });

  it.each([
    ['absent manifest', undefined, 'core_peer', '2.0.0'],
    ['invalid manifest', { ...provider, header: {} }, 'core_peer', '2.0.0'],
    ['mismatched namespace', provider, 'other', '2.0.0'],
    ['mismatched version', provider, 'core_peer', '9.0.0'],
  ])('rejects a peer with %s instead of rewriting its manifest', (_label, input, identity, version) => {
    const { registry, peers } = fixture();

    peers.set([peer(input, identity, version)]);
    expect(registry.all().map(addon => addon.id)).toEqual(['consumer']);
    expect(registry.missingDependencies()).toEqual(['core_peer']);
    registry.stop();
  });

  it('validates registry descriptors separately from addon identity and preserves legacy providers', () => {
    const { registry, peers } = fixture();
    const remote = peer(provider);
    const descriptor = { id: 'fixture:models', contract: 1, revision: 4 };

    peers.set([{ ...remote, meta: { ...remote.meta, registries: [descriptor, { id: 'bad', contract: 0 }, { ...descriptor, id: 'fixture:textures', contract: 2 }] } }]);
    expect(registry.get('core_peer')?.registries).toEqual([descriptor, { ...descriptor, id: 'fixture:textures', contract: 2 }]);
    expect(registry.get('core_peer')?.manifest).toEqual(provider);
    peers.set([remote]);
    expect(registry.get('core_peer')?.registries).toEqual([]);
    expect(registry.has('core_peer')).toBe(true);
    registry.stop();
  });
});

describe('Core registration metadata for incompatible peers', () => {
  it('reports Core registrations while ignoring ordinary incompatible transports', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry, incompatible } = fixture();
    const listener = vi.fn();

    registry.onIncompatible(listener);
    incompatible.set([
      { id: 'raw', pmin: 99, pmax: 99 },
      { id: 'core_peer', pmin: 99, pmax: 99, meta: { runtimeVersion: '1.0.0' } },
    ]);

    expect(registry.incompatible().map(peer => peer.id)).toEqual(['core_peer']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].id).toBe('core_peer');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(registry.has('core_peer')).toBe(false);
    expect(registry.missingDependencies()).toEqual(['core_peer']);
    registry.stop();
  });

  it('observes Runtime metadata appearing and disappearing on an existing transport', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { registry, incompatible } = fixture();
    const listener = vi.fn();
    const raw = { id: 'core_peer', pmin: 99, pmax: 99 };

    registry.onIncompatible(listener);
    incompatible.set([raw]);
    expect(registry.incompatible()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();

    incompatible.set([{ ...raw, meta: { runtimeVersion: '1.0.0' } }]);
    expect(registry.incompatible().map(peer => peer.id)).toEqual(['core_peer']);
    expect(listener).toHaveBeenCalledTimes(1);

    incompatible.set([{ ...raw, meta: { runtimeVersion: '1.0.1' } }]);
    expect(listener).toHaveBeenCalledTimes(1);

    incompatible.set([raw]);
    expect(registry.incompatible()).toEqual([]);

    incompatible.set([{ ...raw, meta: { runtimeVersion: '1.0.1' } }]);
    expect(listener).toHaveBeenCalledTimes(2);
    registry.stop();
  });
});
