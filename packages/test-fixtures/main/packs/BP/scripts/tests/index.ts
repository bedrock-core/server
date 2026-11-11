import { translations, registerTranslations, publishTranslations } from '@bedrock-core/server-runtime/i18n';
import { createResourceBundle } from '@bedrock-core/i18n';
/**
 * GameTests for the bedrock-core stack. Most run several runtimes inside this one script
 * realm (they talk over the real `system` bus); the last asserts the separate peer pack
 * is present, so it only passes when both fixture packs are installed.
 *
 * `./db` and `./sync` hold the tests that need the engine itself rather than several runtimes.
 *
 * Run in-game: `/gametest runset core` (or `/gametest run core:<name>`). The `bench` tag in
 * `./bench` is registered alongside them but runs only when asked for by name.
 */
import { testManifest } from './manifest';
import { computed, effect, observable, signal, type ReadonlyObservable } from '@bedrock-core/observable';
import { Runtime, authorize, core, registerModule } from '@bedrock-core/server-runtime';
import { defineApiModule } from '@bedrock-core/server-runtime/api';
import { schema, worldTarget } from '@bedrock-core/db';
import { createEngineDb } from '@bedrock-core/db/minecraft';
import { defineRegistry, registryReference, isRegistryReference, type Declaration, type Installation, type RegistryDefinition, type RegistryReference } from '@bedrock-core/server-runtime/library';
import { SyncNode } from '@bedrock-core/sync';
import { world } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import './bench';
import './bench-shared';
import './db';
import './sync';

const STRUCTURE = 'core:empty';

gametest('builtin_publishing_without_reader', (test) => {
  const reader = new Runtime();

  test.assert(core.service('core:translations') === undefined, 'Core does not install the optional translation reader');
  const installed = reader.register({ manifest: testManifest('test_builtin_reader', 'Built-in reader'), translations: registerTranslations() });
  const resolve = installed.translations.forLocale('en_US');

  test.startSequence().thenIdle(35).thenExecute(() => {
    try {
      test.assert(resolve('core_fixture_peer.builtin') === 'published without a translation reader', 'late reader registration acquires the peer built-in publication');
      const peer = reader.registry.get('core_fixture_peer');

      test.assert(peer?.registries.some(value => value.id === 'core:translations') === true, 'the publisher advertises its built-in data independently of readers');
    } finally { reader.stop(); }
  }).thenSucceed();
});

gametest('api_structured_snapshots', (test) => {
  const owner = new Runtime();
  const reader = new Runtime();
  const source = new Map([['items', new Set([1])]]);
  const current = observable(source);
  const changed = signal<Map<string, Set<number>>>();
  const shape = { kind: 'object', members: { current: { kind: 'state' }, changed: { kind: 'event' } } } as const;
  const API = { current, changed };
  let events = 0;

  let stop = (): void => {};

  owner.api.provideModule('@fixture/structured-state', shape, API);
  owner.register({ manifest: testManifest('test_structured_owner', 'Structured owner') });
  reader.register({ manifest: testManifest('test_structured_reader', 'Structured reader') });
  const peer = reader.api.createModule<typeof API>(owner.id, '@fixture/structured-state', shape);

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      test.assert(peer.current.get()?.get('items')?.has(1) === true, 'initial collection snapshots reach the consumer');
      stop = peer.changed.subscribe((value) => { if (value.get('items')?.has(2)) { events++; } });
      current.set(new Map([['items', new Set([2])]]));
      changed.emit(new Map([['items', new Set([2])]]));
    })
    .thenIdle(20)
    .thenExecute(() => {
      try {
        const snapshot = peer.current.get();
        let guarded = false;

        try { Reflect.apply(Map.prototype.set, snapshot, ['other', new Set([3])]); } catch { guarded = true; }

        test.assert(snapshot?.get('items')?.has(2) === true && events === 1, 'collection state updates and signals reach the consumer');
        test.assert(guarded && peer.current.get() === snapshot, 'snapshots guard mutation and retain stable read identity');
        test.assert(!Object.isFrozen(source), 'authored collections remain writable');
      } finally { stop(); reader.stop(); owner.stop(); }
    })
    .thenSucceed();
});

declare module '@bedrock-core/server-runtime' {
  interface RuntimeServices {
    'core_fixture:installation': { count: number };
  }
}

function gametest(name: string, fn: (test: Test) => void): void {
  register('core', name, fn).structureName(STRUCTURE).tag('core').maxTicks(220);
}

gametest('library_installation_lifetime', (test) => {
  const owner = new Runtime();
  const reader = new Runtime();
  const API = { echo: async (value: number): Promise<number> => value + 1 };
  const shape = { kind: 'object', members: { echo: { kind: 'function' } } } as const;
  const module = registerModule(API);
  let created = 0;
  const stopped: number[] = [];
  let result: number | undefined;
  let failure: unknown;
  const service: Declaration<{ count: number }> = { install(runtime): Installation<{ count: number }> {
    const value = { count: ++created };

    runtime.provideService('core_fixture:installation', value);

    return { value, stop: (): void => { stopped.push(value.count); } };
  } };

  defineApiModule('@core_fixture/installation', shape, API);
  test.startSequence()
    .thenExecute(() => {
      const registered = owner.register({ manifest: testManifest('test_installation_owner', 'Owner'), module, counter: service });

      reader.register({ manifest: testManifest('test_installation_reader', 'Reader'), counter: service });

      if (registered.module !== API || registered.counter.count !== 1 || reader.service('core_fixture:installation')?.count !== 2) {
        test.fail('library accessors or local services are not owned by their Runtime');
      }

      void reader.api.createModule(owner.id, API).echo(4).then((value) => { result = value; }, (error) => { failure = error; });
    })
    .thenIdle(30)
    .thenExecute(() => {
      if (failure !== undefined || result !== 5) { test.fail('registered module call failed: ' + String(failure)); }

      owner.uninstall(service);
      owner.uninstall(module);

      if (Reflect.has(owner, 'counter') || owner.service('core_fixture:installation') !== undefined
        || stopped.join(',') !== '1' || reader.service('core_fixture:installation')?.count !== 2) {
        test.fail('uninstall affected another Runtime or retained an owned accessor');
      }
    })
    .thenIdle(12)
    .thenExecute(() => {
      if (reader.registry.get(owner.id)?.apis.includes('@core_fixture/installation')) { test.fail('withdrawn module remains advertised'); }

      owner.stop();
      reader.stop();

      if (stopped.join(',') !== '1,2') { test.fail('library cleanup did not run once per installation'); }
    })
    .thenSucceed();
});

// Core dependencies require a Runtime advertisement and a compatible public module.
gametest('discovery_and_rpc', (test) => {
  const a = new Runtime();
  const b = new Runtime();
  const aManifest = testManifest('test_demo_a', 'A');
  const bManifest = testManifest('test_demo_b', 'B');
  const raw = new SyncNode({ id: bManifest.namespace, version: '1.0.0' });
  const shape = { kind: 'object', members: { ping: { kind: 'function' } } } as const;

  a.register({
    manifest: {
      ...aManifest,
      dependencies: [...aManifest.dependencies ?? [], { namespace: bManifest.namespace, uuid: bManifest.header.uuid, version: bManifest.header.version }],
    },
  });
  raw.start();

  let registrations = 0;
  let unregistrations = 0;
  let satisfied = 0;
  let reply: unknown;
  const stopRegistration = a.registry.onRegister((addon) => { if (addon.id === bManifest.namespace) { registrations++; } });
  const stopUnregistration = a.registry.onUnregister((addon) => { if (addon.id === bManifest.namespace) { unregistrations++; } });
  const stopSatisfied = a.registry.onDependenciesSatisfied(() => { satisfied++; });
  const client = a.api.createModule<{ ping(): Promise<string> }>(bManifest.namespace, '@fixture/ping', shape);

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      if (!raw.discovery.getPeer(a.id)) { test.fail('raw SyncNode did not discover the Runtime'); }

      if (a.registry.has(bManifest.namespace)) { test.fail('raw SyncNode was counted as a Core registration'); }

      if (!a.registry.missingDependencies().includes(bManifest.namespace)) { test.fail('raw SyncNode satisfied a Core dependency'); }

      if (registrations !== 0 || satisfied !== 0) { test.fail('raw SyncNode fired Core registration callbacks'); }

      raw.stop();
      b.api.provideModule('@fixture/ping', shape, { ping: async (): Promise<string> => 'pong' });
      b.register({ manifest: bManifest });
    })
    .thenIdle(20)
    .thenExecute(() => { void client.ping().then((value) => { reply = value; }, (error) => { reply = String(error); }); })
    .thenIdle(20)
    .thenExecute(() => {
      if (!a.registry.has(b.id)) { test.fail('A did not discover B'); }

      if (reply !== 'pong') { test.fail('peer call did not return pong: ' + String(reply)); }

      if (a.registry.missingDependencies().includes(b.id)) { test.fail('registered Runtime did not satisfy its Core dependency'); }

      if (registrations !== 1 || satisfied !== 1) { test.fail('Runtime registration did not fire Core callbacks exactly once'); }

      b.stop();
      raw.start();
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (a.registry.has(bManifest.namespace)) { test.fail('raw transport advertisement retained a Core registration'); }

      if (unregistrations !== 1) { test.fail('Core unregistration was not observed when Runtime metadata disappeared'); }

      stopRegistration();
      stopUnregistration();
      stopSatisfied();
      raw.stop();
      a.stop();
    })
    .thenSucceed();
});

// A public module call can target its own registered runtime.
gametest('rpc_to_self', (test) => {
  const owner = new Runtime();
  const shape = { kind: 'object', members: { echo: { kind: 'function' } } } as const;

  owner.api.provideModule('@fixture/self', shape, { echo: async (value: number): Promise<number> => value });
  owner.register({ manifest: testManifest('test_self_peer', 'A') });

  const client = owner.api.createModule<{ echo(value: number): Promise<number> }>(owner.id, '@fixture/self', shape);
  let reply: unknown;

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => { void client.echo(42).then((value) => { reply = value; }, (error) => { reply = String(error); }); })
    .thenIdle(20)
    .thenExecute(() => {
      if (reply !== 42) { test.fail('self peer call failed: ' + String(reply)); }

      owner.stop();
    })
    .thenSucceed();
});

// Provider observables become readonly snapshots for peer module consumers.
gametest('shared_replication', (test) => {
  const owner = new Runtime();
  const own = { volume: observable(5), status: observable({ name: 'none', active: false }) };
  const shape = {
    kind: 'object',
    members: { volume: { kind: 'state' }, status: { kind: 'state' } },
  } as const;

  owner.api.provideModule('@fixture/state', shape, own);
  owner.register({ manifest: testManifest('test_state_a', 'A') });

  const consumer = new Runtime();

  consumer.register({ manifest: testManifest('test_state_b', 'B') });

  const mirror = consumer.api.createModule<typeof own>(owner.id, '@fixture/state', shape);
  const volume: ReadonlyObservable<number | undefined> = mirror.volume;
  const seen: number[] = [];

  own.volume.set(7);
  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      if (volume.get() !== 7) { test.fail('volume did not replicate to the consumer'); }

      if (mirror.status.get()?.name !== 'none') { test.fail('the initial object snapshot did not arrive'); }

      if ('set' in volume) { test.fail('the consumer snapshot exposes a write operation'); }

      volume.subscribe((next) => { if (next !== undefined) { seen.push(next); } });
      own.status.set({ name: 'race', active: true });
      own.volume.set(9);
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (own.volume.get() !== 9) { test.fail('the owner observable changed unexpectedly'); }

      if (mirror.status.get()?.name !== 'race') { test.fail('the object snapshot did not update'); }

      if (seen.length !== 1 || seen[0] !== 9) { test.fail('unexpected snapshot changes: ' + JSON.stringify(seen)); }

      owner.stop();
      consumer.stop();
    })
    .thenSucceed();
});

// Same creator, different addon → distinct namespaces → coexist. Identical namespace → collision.
gametest('distinct_vs_collision', (test) => {
  const x = new Runtime();

  x.register({ manifest: testManifest('test_dup_a', 'X') });
  const y = new Runtime();

  y.register({ manifest: testManifest('test_dup_b', 'Y') });

  const c1 = new Runtime();

  c1.register({ manifest: testManifest('test_clash_same', 'First') });
  let collided = false;

  c1.registry.onNamespaceCollision(() => { collided = true; });
  const c2 = new Runtime();

  c2.register({ manifest: testManifest('test_clash_same', 'Second') });

  test.startSequence()
    .thenIdle(30)
    .thenExecute(() => {
      if (x.id === y.id) { test.fail('distinct namespaces must yield distinct ids'); }

      if (!x.registry.has(y.id)) { test.fail('X should see Y as an ordinary peer'); }

      if (!collided) { test.fail('identical namespaces should report a collision'); }

      for (const r of [x, y, c1, c2]) { r.stop(); }
    })
    .thenSucceed();
});

// Optional behavior follows local configuration and peer snapshots, with owned teardown.
gametest('feature_toggle', (test) => {
  const consumer = new Runtime();
  const provider = new Runtime();
  const configured = observable(true);
  const accepting = observable<boolean | undefined>(true);
  const events = signal<number>();
  const shape = { kind: 'object', members: { accepting: { kind: 'state' } } } as const;
  const peer = consumer.api.createModule<{ accepting: ReadonlyObservable<boolean | undefined> }>('test_lb_main', '@fixture/optional', shape);
  let active = false;
  let handled = 0;

  let release = (): void => {};

  let withdraw = (): void => {};

  consumer.register({
    manifest: testManifest('test_game_main', 'Game'),
    integration: {
      install() {
        const enabled = computed(() => configured.get() && peer.accepting.get() === true, [configured, peer.accepting]);

        let disconnect = (): void => {};

        const stopEffect = effect(() => {
          disconnect();
          active = enabled.get();

          disconnect = active ? events.subscribe((value) => { handled += value; }) : (): void => {};
        }, [enabled]);

        release = (): void => { stopEffect(); disconnect(); enabled.dispose(); active = false; };

        return { value: undefined, stop: release };
      },
    },
  });

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => {
      if (active) { test.fail('integration enabled before its peer snapshot arrived'); }

      withdraw = provider.api.provideModule('@fixture/optional', shape, { accepting });
      provider.register({ manifest: testManifest('test_lb_main', 'Leaderboard') });
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (!active) { test.fail('integration did not enable after its peer appeared'); }

      configured.set(false);

      if (active) { test.fail('local configuration did not disable the integration immediately'); }

      events.emit(10);
      configured.set(true);
      events.emit(1);

      if (handled !== 1) { test.fail('integration retained a disabled or duplicate listener'); }

      withdraw();
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (active) { test.fail('integration stayed active after its peer module was withdrawn'); }

      provider.api.provideModule('@fixture/optional', shape, { accepting });
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (!active) { test.fail('integration did not reconnect when its peer returned'); }

      consumer.stop();
      consumer.stop();
      configured.set(false);
      configured.set(true);
      events.emit(10);

      if (active || handled !== 1) { test.fail('stopped integration kept a listener or effect'); }

      provider.stop();
    })
    .thenSucceed();
});

// Cross-pack: the peer pack must be registered with our live core. This is the only test
// that needs two real packs installed; every other test builds its runtimes in this realm.
gametest('cross_pack_peer_present', (test) => {
  test.startSequence()
    .thenIdle(40)
    .thenExecute(() => {
      const peer = core.registry.get('core_fixture_peer');

      if (peer === undefined) {
        test.fail('peer pack not present — is test-fixture-peer installed and enabled?');

        return;
      }

      const serverApiVersion = core.manifest.dependencies?.find(dependency => dependency.module_name === '@minecraft/server')?.version;

      test.assert(peer.manifest.namespace === peer.id, 'The remote manifest keeps its owning namespace');
      test.assert(peer.manifest.header.uuid === '6b83adc1-ffae-4081-bc77-d0c7663cad33', 'The remote manifest retains its native pack UUID');
      test.assert(peer.manifest.header.name === 'Bedrock Core fixture peer' && peer.manifest.header.version === '1.0.0', 'Native header fields survive discovery');
      test.assert(peer.manifest.metadata?.authors?.includes('DrAv0011') === true, 'Native author metadata survives discovery');
      test.assert(peer.manifest.modules.some(module => module.type === 'script' && module.entry === 'scripts/main.ts'), 'Registered script modules survive discovery');
      test.assert(typeof serverApiVersion === 'string' && peer.manifest.dependencies?.some(dependency => dependency.module_name === '@minecraft/server' && dependency.version === serverApiVersion) === true, 'Native dependency objects survive discovery');
    })
    .thenSucceed();
});

// Only explicitly exported functions expose the owner's private database.
gametest('rpc_over_local_db', (test) => {
  const owner = new Runtime();
  const peer = new Runtime();

  owner.register({ manifest: testManifest('test_notes_a', 'A') });
  peer.register({ manifest: testManifest('test_notes_b', 'B') });

  const database = createEngineDb(owner.namespace);

  test.runOnFinish(() => database.stop());
  const notes = database.collection('notes', {
    schema: schema<{ text: string; seen: number }>({ defaults: { text: '', seen: 0 } }),
  });
  const dimension = test.getDimension();

  notes.for(dimension).set({ text: 'hello', seen: 1 });

  const exports = {
    async note(dimId: string, actorId?: string): Promise<{ text: string; seen: number } | undefined> {
      authorize({ dimension: dimId }, actorId, 'read');

      return notes.for(world.getDimension(dimId)).get();
    },
    async markSeen(dimId: string, actorId?: string): Promise<{ text: string; seen: number } | undefined> {
      authorize({ dimension: dimId }, actorId, 'write');

      const document = notes.for(world.getDimension(dimId));

      document.patch({ seen: (document.get()?.seen ?? 0) + 1 });

      return document.get();
    },
  };
  const shape = {
    kind: 'object',
    members: {
      note: { kind: 'function' },
      markSeen: { kind: 'function' },
    },
  } as const;

  owner.api.provideModule('@fixture/notes', shape, exports);

  const client = peer.api.createModule<typeof exports>(owner.id, '@fixture/notes', shape);
  const privateDb = peer.api.createModule<{ read(): Promise<unknown> }>(owner.id, '@bedrock-core/db', {
    kind: 'object', members: { read: { kind: 'function' } },
  });
  let read: unknown;
  let written: unknown;
  let unserved: string | undefined;

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      void client.note(dimension.id).then((value) => { read = value; }, (error) => { read = String(error); });
      void client.markSeen(dimension.id).then((value) => { written = value; }, (error) => { written = String(error); });
      void privateDb.read().catch((error: unknown) => { unserved = String(error); });
    })
    .thenIdle(130)
    .thenExecute(() => {
      try {
        if (JSON.stringify(read) !== JSON.stringify({ text: 'hello', seen: 1 })) {
          test.fail('peer read ' + JSON.stringify(read));

          return;
        }

        if (JSON.stringify(written) !== JSON.stringify({ text: 'hello', seen: 2 })) {
          test.fail('write replied ' + JSON.stringify(written));

          return;
        }

        if (notes.for(dimension).get()?.seen !== 2) {
          test.fail('the owner document did not change');

          return;
        }

        if (unserved === undefined || !unserved.includes('unavailable')) {
          test.fail('private database was exposed: ' + String(unserved));

          return;
        }
      } finally {
        owner.stop();
        peer.stop();
      }
    })
    .thenSucceed();
});

// Standard signals deliver owner events once and never replay them to late subscribers.
gametest('events_broadcast', (test) => {
  const owner = new Runtime();
  const peer = new Runtime();
  const purchase = signal<{ item: string }>();
  const shape = { kind: 'object', members: { purchase: { kind: 'event' } } } as const;
  const heard: string[] = [];
  const late: string[] = [];

  peer.register({ manifest: testManifest('test_events_b', 'B') });

  const client = peer.api.createModule<{ purchase: typeof purchase }>('test_events_a', '@fixture/events', shape);

  client.purchase.subscribe(({ item }) => { heard.push('peer:' + item); });
  owner.api.provideModule('@fixture/events', shape, { purchase });
  owner.register({ manifest: testManifest('test_events_a', 'A') });
  purchase.subscribe(({ item }) => { heard.push('self:' + item); });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => { purchase.emit({ item: 'sword' }); })
    .thenIdle(10)
    .thenExecute(() => {
      client.purchase.subscribe(({ item }) => { late.push(item); });

      if (heard.length !== 2 || !heard.includes('self:sword') || !heard.includes('peer:sword')) { test.fail('unexpected event delivery: ' + JSON.stringify(heard)); }

      if (late.length !== 0) { test.fail('an event was replayed to a late listener'); }

      purchase.emit({ item: 'shield' });
    })
    .thenIdle(10)
    .thenExecute(() => {
      if (late.length !== 1 || late[0] !== 'shield') { test.fail('unexpected late events: ' + JSON.stringify(late)); }

      owner.stop();
      peer.stop();
    })
    .thenSucceed();
});

gametest('runtime_cleanup_lifetime', (test) => {
  const owner = new Runtime();
  const identity = testManifest('test_cleanup_lifetime', 'Cleanup');
  let cleaned = false;

  test.startSequence().thenExecute(() => {
    const database = createEngineDb(identity.namespace);

    owner.register({
      manifest: identity,
      storage: { install() { return { value: undefined, stop(): void { database.stop(); } }; } },
      earlier: { install() { return { value: undefined, stop(): void { cleaned = true; } }; } },
      broken: { install() { return { value: undefined, stop(): void { throw new Error('cleanup failure'); } }; } },
    });
    const pending = database.collection('pending', {
      schema: schema<{ value: number }>(),
      accept: worldTarget(),
      coalesce: true,
    }).for(world);

    pending.set({ value: 7 });
    let reported = false;

    try { owner.stop(); } catch (error) { reported = error instanceof AggregateError; }

    if (!reported || !cleaned || owner.registered) { test.fail('runtime cleanup did not finish and report the failing declaration'); }

    const reader = createEngineDb(identity.namespace);
    const saved = reader.collection('pending', { schema: schema<{ value: number }>(), accept: worldTarget() }).for(world).get();

    if (saved?.value !== 7) { test.fail('the storage declaration did not flush its pending write'); }

    reader.stop();
    owner.stop();
  }).thenSucceed();
});

gametest('registry_publication_lifetime', (test) => {
  const owner = new Runtime();
  const reader = new Runtime();
  const records: RegistryDefinition<{ texture: string }> = {
    id: 'core_fixture:models', contract: 1,
    accepts: (value): value is { texture: string } => typeof value === 'object' && value !== null
      && 'texture' in value && typeof value.texture === 'string',
  };
  const registered = owner.register({
    manifest: testManifest('test_registry_owner', 'Registry owner'),
    models: defineRegistry(records, { revision: 7, coverage: { min: [1, 26, 50] },
      entries: { 'minecraft:stone': { texture: 'textures/blocks/stone' } } }),
  });

  const { models } = registered;

  test.assert(registered === owner, 'register returns its Runtime identity');
  test.assert(Reflect.get(owner, 'models') === models, 'the Runtime owns its registry accessor');
  test.assert(owner.registry.self?.manifest === owner.manifest, 'local identity owns the manifest');
  reader.register({ manifest: testManifest('test_registry_reader', 'Registry reader') });
  test.runOnFinish(() => { owner.stop(); reader.stop(); });

  let releaseApi = (): void => {};

  test.startSequence().thenIdle(16).thenExecute(() => {
    const provider = reader.registry.get(owner.id);
    const descriptor = provider?.registries[0];

    test.assert(descriptor?.id === records.id && descriptor.contract === 1 && descriptor.revision === 7, 'provider descriptors arrive through discovery');
    test.assert(descriptor?.minecraft?.min[2] === 50, 'Minecraft coverage is independent of addon version');
    test.assert(descriptor !== undefined && !('entries' in descriptor), 'descriptors contain no records');
    test.assert(provider !== undefined && !('registries' in provider.manifest), 'the native manifest stays separate');
    test.assert(models.get('minecraft:stone')?.texture === 'textures/blocks/stone', 'library publication retains its local data');
    releaseApi = owner.api.provideModule('@core_fixture/registry_api', { kind: 'object', members: {} }, {});
  }).thenIdle(8).thenExecute(() => {
    const provider = reader.registry.get(owner.id);

    test.assert(provider?.apis.includes('@core_fixture/registry_api') === true && provider.registries[0]?.id === records.id, 'API readiness retains registry advertisements');
    releaseApi();
    models.stop();
    test.assert(Object.keys(models.snapshot.get().entries).length === 0, 'withdrawal clears retained snapshots');
  }).thenIdle(8).thenExecute(() => {
    const provider = reader.registry.get(owner.id);

    test.assert(provider !== undefined && provider.registries.length === 0 && provider.apis.length === 0, 'withdrawal keeps the addon registered and clears its advertisements');
  }).thenSucceed();
});

gametest('translations_live_updates', (test) => {
  const owner = new Runtime();
  const reader = new Runtime();
  const ownerReader = registerTranslations();

  owner.register({ manifest: testManifest('test_translation_owner', 'Translation owner'), translations: ownerReader });
  reader.register({ manifest: testManifest('test_translation_reader', 'Translation reader'), translations: registerTranslations() });
  const resolve = translations(reader).forLocale('en_US');

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => {
      translations(owner).provide(createResourceBundle('test_translation_owner', { en_US: { text: 'first' } }));
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (resolve('test_translation_owner.text') !== 'first') { test.fail('the retained resolver did not receive the first peer bundle'); }

      translations(owner).provide(createResourceBundle('test_translation_owner', { en_US: { text: 'second' } }));
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (resolve('test_translation_owner.text') !== 'second') { test.fail('the retained resolver kept the replaced peer bundle'); }

      if (translations(reader).bundles.get()['test_translation_owner'] === undefined) { test.fail('the observable bundle state is missing the peer'); }

      owner.uninstall(ownerReader);
      publishTranslations(owner, createResourceBundle('test_translation_owner', { en_US: { text: 'publisher-only' } }));
    })
    .thenIdle(20)
    .thenExecute(() => {
      test.assert(owner.service('core:translations') === undefined, 'the publisher no longer has a translation reader');
      test.assert(resolve('test_translation_owner.text') === 'publisher-only', 'the built-in publisher survives reader removal');
      owner.stop();
      reader.stop();
    })
    .thenSucceed();
});

gametest('registry_selective_links', (test) => {
  interface Texture { path: string }
  interface Model { texture: RegistryReference<Texture> }
  const textures: RegistryDefinition<Texture> = { id: 'core_fixture:linked_textures', contract: 1,
    accepts: (value): value is Texture => typeof value === 'object' && value !== null && 'path' in value && typeof value.path === 'string' };
  const models: RegistryDefinition<Model> = { id: 'core_fixture:linked_models', contract: 1,
    accepts: (value): value is Model => typeof value === 'object' && value !== null && 'texture' in value && isRegistryReference(textures, value.texture) };
  const owner = new Runtime();
  const alternate = new Runtime();
  const reader = new Runtime();
  const pinned = registryReference(textures, 'minecraft:stone', { version: 0 });
  const published = owner.register({ manifest: testManifest('test_link_owner', 'Link owner'),
    models: defineRegistry(models, { revision: 7, entries: { 'minecraft:stone': { texture: pinned } } }),
    textures: defineRegistry(textures, { revision: 7, coverage: { min: [1, 26, 50], max: [1, 26, 70] },
      entries: { 'minecraft:stone': { path: 'linked' } } }),
  });

  alternate.register({ manifest: testManifest('test_link_alternate', 'Alternate'),
    textures: defineRegistry(textures, { revision: 9, entries: { 'minecraft:stone': { path: 'alternate' } } }),
  });
  const views = reader.register({ manifest: testManifest('test_link_reader', 'Link reader'),
    models: defineRegistry(models), textures: defineRegistry(textures, { minecraft: [1, 26, 60] }),
  });

  test.runOnFinish(() => { reader.stop(); alternate.stop(); owner.stop(); });
  test.startSequence().thenIdle(20).thenExecute(() => {
    const model = views.models.resolve(registryReference(models, 'minecraft:stone'));

    test.assert(model.status === 'ready', 'the consumer acquires a provider-only registry');

    if (model.status !== 'ready') { return; }

    const linked = views.textures.resolve(model.entry.value.texture, model.entry);

    test.assert(views.textures.get('minecraft:stone')?.path === 'alternate', 'dataset revision selects the newer provider independently of addon version');
    test.assert(linked.status === 'ready' && linked.entry.value.path === 'linked', 'a related lookup keeps its owning provider and dataset revision');
    published.textures.set('minecraft:stone', { path: 'updated' });
  }).thenIdle(12).thenExecute(() => {
    const model = views.models.resolve(registryReference(models, 'minecraft:stone'));

    if (model.status !== 'ready') {
      test.fail('model provider disappeared');

      return;
    }

    test.assert(views.textures.resolve(pinned, model.entry).status === 'loading', 'a pinned link does not mix snapshot versions');
    const updated = views.textures.resolve(registryReference(textures, 'minecraft:stone', { version: 1 }), model.entry);

    test.assert(updated.status === 'ready' && updated.entry.value.path === 'updated', 'the updated pin resolves the new data');
    published.textures.stop();
  }).thenIdle(12).thenExecute(() => {
    const model = views.models.resolve(registryReference(models, 'minecraft:stone'));

    if (model.status !== 'ready') {
      test.fail('model provider disappeared');

      return;
    }

    test.assert(views.textures.resolve(pinned, model.entry).status === 'unavailable', 'withdrawal cannot redirect a related lookup to another provider');
    views.textures.stop();
    test.assert(views.textures.snapshot.get().status === 'stopped', 'consumer teardown clears its retained view');
  }).thenSucceed();
});
