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
import { Runtime, authorize, core, schema, worldTarget } from '@bedrock-core/server-runtime';
import { SyncNode } from '@bedrock-core/sync';
import { world } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import './bench';
import './bench-shared';
import './db';
import './sync';

const STRUCTURE = 'core:empty';

function gametest(name: string, fn: (test: Test) => void): void {
  register('core', name, fn).structureName(STRUCTURE).tag('core').maxTicks(220);
}

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
      install(): void {
        const enabled = computed(() => configured.get() && peer.accepting.get() === true, [configured, peer.accepting]);

        let disconnect = (): void => {};

        const stopEffect = effect(() => {
          disconnect();
          active = enabled.get();

          disconnect = active ? events.subscribe((value) => { handled += value; }) : (): void => {};
        }, [enabled]);

        release = (): void => { stopEffect(); disconnect(); enabled.dispose(); active = false; };
      },
      stop(): void { release(); },
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

      test.assert(peer.manifest.namespace === peer.id, 'The remote manifest keeps its owning namespace');
      test.assert(peer.manifest.header.uuid === '6b83adc1-ffae-4081-bc77-d0c7663cad33', 'The remote manifest retains its native pack UUID');
      test.assert(peer.manifest.header.name === 'Bedrock Core fixture peer' && peer.manifest.header.version === '1.0.0', 'Native header fields survive discovery');
      test.assert(peer.manifest.metadata?.authors?.includes('DrAv0011') === true, 'Native author metadata survives discovery');
      test.assert(peer.manifest.modules.some(module => module.type === 'script' && module.entry === 'scripts/main.js'), 'Native script modules survive discovery');
      test.assert(peer.manifest.dependencies?.some(dependency => dependency.module_name === '@minecraft/server' && dependency.version === '2.10.0') === true, 'Native dependency objects survive discovery');
    })
    .thenSucceed();
});

// Only explicitly exported functions expose the owner's private database.
gametest('rpc_over_local_db', (test) => {
  const owner = new Runtime();
  const peer = new Runtime();

  owner.register({ manifest: testManifest('test_notes_a', 'A') });
  peer.register({ manifest: testManifest('test_notes_b', 'B') });

  const notes = owner.db.collection('notes', {
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
    owner.register({
      manifest: identity,
      earlier: { install(): void {}, stop(): void { cleaned = true; } },
      broken: { install(): void {}, stop(): void { throw new Error('cleanup failure'); } },
    });
    const pending = owner.db.collection('pending', {
      schema: schema<{ value: number }>(),
      accept: worldTarget(),
      coalesce: true,
    }).for(world);

    pending.set({ value: 7 });
    let reported = false;

    try { owner.stop(); } catch (error) { reported = error instanceof AggregateError; }

    if (!reported || !cleaned || owner.registered) { test.fail('runtime cleanup did not finish and report the failing declaration'); }

    const reader = new Runtime();

    reader.register({ manifest: identity });
    const saved = reader.db.collection('pending', { schema: schema<{ value: number }>(), accept: worldTarget() }).for(world).get();

    if (saved?.value !== 7) { test.fail('stopping the runtime did not flush its pending database write'); }

    reader.stop();
    owner.stop();
  }).thenSucceed();
});

gametest('translations_live_updates', (test) => {
  const owner = new Runtime();
  const reader = new Runtime();

  owner.register({ manifest: testManifest('test_translation_owner', 'Translation owner') });
  reader.register({ manifest: testManifest('test_translation_reader', 'Translation reader') });
  const resolve = reader.translations.forLocale('en_US');

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => {
      owner.translations.provide(createResourceBundle('test_translation_owner', { en_US: { text: 'first' } }));
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (resolve('test_translation_owner.text') !== 'first') { test.fail('the retained resolver did not receive the first peer bundle'); }

      owner.translations.provide(createResourceBundle('test_translation_owner', { en_US: { text: 'second' } }));
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (resolve('test_translation_owner.text') !== 'second') { test.fail('the retained resolver kept the replaced peer bundle'); }

      if (reader.translations.bundles.get()['test_translation_owner'] === undefined) { test.fail('the observable bundle state is missing the peer'); }

      owner.stop();
      reader.stop();
    })
    .thenSucceed();
});
