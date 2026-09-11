/**
 * GameTests for the bedrock-core stack. Most run several runtimes inside this one script
 * realm (they talk over the real `system` bus); the last asserts the separate peer pack
 * is present, so it only passes when both fixture packs are installed.
 *
 * Run in-game: `/gametest runset core` (or `/gametest run core:<name>`). The `bench` tag in
 * `./bench` is registered alongside them but runs only when asked for by name.
 */
import './bench';
import './bench-shared';
import { world } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import { Runtime, authorize, core, event, schema } from '@bedrock-core/server-runtime';

const STRUCTURE = 'core:empty';

function gametest(name: string, fn: (test: Test) => void): void {
  register('core', name, fn).structureName(STRUCTURE).tag('core').maxTicks(220);
}

// Two runtimes discover each other and complete an RPC round-trip. register() auto-starts.
gametest('discovery_and_rpc', (test) => {
  const a = new Runtime();

  a.register({ manifest: { creator: 'test', pack: 'demo_a', packName: 'A', version: '1.0.0' } });
  const b = new Runtime();

  b.register({ manifest: { creator: 'test', pack: 'demo_b', packName: 'B', version: '1.0.0' } });
  b.rpc.onRequest('ping', () => 'pong');

  let reply: unknown;

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => void a.rpc.request(b.id, 'ping').then((r) => { reply = r; }))
    .thenIdle(20)
    .thenExecute(() => {
      if (!a.registry.has(b.id)) { test.fail('A did not discover B'); }

      if (reply !== 'pong') { test.fail(`expected 'pong', got ${String(reply)}`); }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// A runtime can RPC itself. Self-addressed messages loop back locally (the bus can't
// hear its own echoes over the wire); the config UI relies on this to read the config of
// the very addon hosting it.
gametest('rpc_to_self', (test) => {
  const a = new Runtime();

  a.register({ manifest: { creator: 'test', pack: 'self_rpc', packName: 'A', version: '1.0.0' } });
  a.rpc.onRequest('echo', params => params);

  let reply: unknown;

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => void a.rpc.request(a.id, 'echo', 42).then((r) => { reply = r; }))
    .thenIdle(20)
    .thenExecute(() => {
      if (reply !== 42) { test.fail(`self-RPC failed: expected 42, got ${String(reply)}`); }

      a.stop();
    })
    .thenSucceed();
});

// A shared tree replicates between runtimes: the owner writes, a peer reads it typed and hears
// the change, and nothing a peer writes into the owner's namespace is applied anywhere.
gametest('shared_replication', (test) => {
  const a = new Runtime();
  const { shared } = a.register({
    manifest: { creator: 'test', pack: 'shared_a', packName: 'A', version: '1.0.0' },
    shared: { volume: 5, event: { name: 'none', active: false } },
  });
  const b = new Runtime();

  b.register({ manifest: { creator: 'test', pack: 'shared_b', packName: 'B', version: '1.0.0' } });

  const seen: number[] = [];

  shared.volume.set(7);
  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      const mirror = b.shared.of<{ volume: number; event: { name: string; active: boolean } }>(a.namespace);

      if (mirror === undefined) {
        test.fail('B never saw the shape');

        return;
      }

      if (mirror.volume.get() !== 7) { test.fail('volume did not replicate to B'); }

      // An object key travels whole.
      if (mirror.event.get()?.name !== 'none') { test.fail(`an object key did not replicate: ${JSON.stringify(mirror.event.get())}`); }

      mirror.volume.subscribe((next) => { if (next !== undefined) { seen.push(next); } });

      // A peer reaching past its read-only tree to the mirror itself changes nothing.
      b.node.state.set(a.namespace, 'volume', 1);
      shared.event.set({ name: 'race', active: true });
      shared.volume.set(9);
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (shared.volume.get() !== 9) { test.fail(`a peer write reached the owner: ${String(shared.volume.get())}`); }

      const mirror = b.shared.of<{ volume: number; event: { name: string; active: boolean } }>(a.namespace);

      if (mirror?.event.get()?.name !== 'race') { test.fail('the owner write did not reach the peer'); }

      if (seen.length !== 1 || seen[0] !== 9) { test.fail(`the peer's subscriber saw ${JSON.stringify(seen)}, expected [9]`); }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// Same creator, different addon → distinct namespaces → coexist. Identical namespace → collision.
gametest('distinct_vs_collision', (test) => {
  const x = new Runtime();

  x.register({ manifest: { creator: 'test', pack: 'dup_a', packName: 'X', version: '1.0.0' } });
  const y = new Runtime();

  y.register({ manifest: { creator: 'test', pack: 'dup_b', packName: 'Y', version: '1.0.0' } });

  const c1 = new Runtime();

  c1.register({ manifest: { creator: 'test', pack: 'clash_same', packName: 'First', version: '1.0.0' } });
  let collided = false;

  c1.registry.onNamespaceCollision(() => { collided = true; });
  const c2 = new Runtime();

  c2.register({ manifest: { creator: 'test', pack: 'clash_same', packName: 'Second', version: '1.0.0' } });

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

// A feature enables only once its required namespace is present.
gametest('feature_toggle', (test) => {
  const consumer = new Runtime();

  consumer.register({ manifest: { creator: 'test', pack: 'game_main', packName: 'Game', version: '1.0.0', optionalDependencies: ['test_lb_main'] } });

  let enabled = 0;

  consumer.features.add('lb-sync', { condition: r => r.registry.has('test_lb_main'), onEnable: () => enabled++, onDisable: () => { /* noop */ } });

  const provider = new Runtime();

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      if (enabled !== 0) { test.fail('feature enabled before its provider was present'); }

      provider.register({ manifest: { creator: 'test', pack: 'lb_main', packName: 'Leaderboard', version: '1.0.0' } });
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (enabled !== 1) { test.fail('feature did not enable when provider appeared'); }

      consumer.stop();
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
      if (!core.registry.has('core_fixture_peer')) {
        test.fail('peer pack not present — is test-fixture-peer installed and enabled?');
      }
    })
    .thenSucceed();
});

// db is local: a peer asking for a collection over rpc gets nothing, because nothing serves it.
// What crosses is what the owner registered itself — an rpc method over its own documents, with
// the player rule in front of it and its own event behind.
gametest('rpc_over_local_db', (test) => {
  const owner = new Runtime();

  owner.register({ manifest: { creator: 'test', pack: 'rpc_a', packName: 'A', version: '1.0.0' } });

  const peer = new Runtime();

  peer.register({ manifest: { creator: 'test', pack: 'rpc_b', packName: 'B', version: '1.0.0' } });

  const notes = owner.db.collection('notes', {
    schema: schema<{ text: string; seen: number }>({ defaults: { text: '', seen: 0 } }),
  });
  const dimension = test.getDimension();

  notes.for(dimension).set({ text: 'hello', seen: 1 });

  interface NotesApi {
    note(params: { dimId: string; actorId?: string }): { text: string; seen: number } | undefined;
    markSeen(params: { dimId: string; actorId?: string }): { text: string; seen: number } | undefined;
  }

  owner.rpc.serve<NotesApi>({
    note: ({ dimId, actorId }) => {
      authorize({ dimension: dimId }, actorId, 'read');

      return notes.for(world.getDimension(dimId)).get();
    },
    markSeen: ({ dimId, actorId }) => {
      authorize({ dimension: dimId }, actorId, 'write');

      const doc = notes.for(world.getDimension(dimId));

      doc.patch({ seen: (doc.get()?.seen ?? 0) + 1 });

      return doc.get();
    },
  });

  const client = peer.rpc.typed<NotesApi>(owner.id);
  let read: unknown;
  let written: unknown;
  let unserved: string | undefined;

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      void client.note({ dimId: dimension.id }).then((r) => { read = r; });
      void client.markSeen({ dimId: dimension.id }).then((r) => { written = r; });
      // The collection itself is not on the wire: db serves nobody.
      void peer.rpc.request(owner.id, 'core:db.get', { collection: 'notes' })
        .catch((error: unknown) => { unserved = String(error); });
    })
    .thenIdle(30)
    .thenExecute(() => {
      if (JSON.stringify(read) !== JSON.stringify({ text: 'hello', seen: 1 })) {
        test.fail(`peer read ${JSON.stringify(read)}`);
      }

      // The reply carries the document after the write, so no second round trip is needed.
      if (JSON.stringify(written) !== JSON.stringify({ text: 'hello', seen: 2 })) {
        test.fail(`write replied ${JSON.stringify(written)}`);
      }

      if (notes.for(dimension).get()?.seen !== 2) { test.fail('the owner document did not change'); }

      if (unserved === undefined || !unserved.includes('unknown method')) {
        test.fail(`db answered a peer directly: ${String(unserved)}`);
      }

      owner.stop();
      peer.stop();
    })
    .thenSucceed();
});

// Events cross realms and are kept by nobody: the owner hears its own, a peer that subscribed
// before the owner existed hears it too, and a listener attached afterwards has missed it.
gametest('events_broadcast', (test) => {
  const a = new Runtime();
  const b = new Runtime();
  const heard: string[] = [];
  const late: string[] = [];

  b.register({ manifest: { creator: 'test', pack: 'events_b', packName: 'B', version: '1.0.0' } });

  // Before A has registered at all: an event missed is missed for good, so this must attach now.
  b.events.of<{ purchase: ReturnType<typeof event<{ item: string }>> }>('test_events_a')
    .purchase.subscribe(({ item }, from) => { heard.push(`${from}:${item}`); });

  const { events } = a.register({
    manifest: { creator: 'test', pack: 'events_a', packName: 'A', version: '1.0.0' },
    events: { purchase: event<{ item: string }>() },
  });

  events.purchase.subscribe(({ item }) => { heard.push(`self:${item}`); });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => { events.purchase.emit({ item: 'sword' }); })
    .thenIdle(10)
    .thenExecute(() => {
      // A listener attached now has missed the one already announced.
      b.events.of<{ purchase: ReturnType<typeof event<{ item: string }>> }>('test_events_a')
        .purchase.subscribe(({ item }) => { late.push(item); });

      if (heard.length !== 2) { test.fail(`heard ${JSON.stringify(heard)}, expected the owner and the peer`); }

      if (!heard.includes('self:sword')) { test.fail('the owner did not hear its own event'); }

      if (!heard.includes('test_events_a:sword')) { test.fail(`the peer did not hear it, or named the wrong sender: ${JSON.stringify(heard)}`); }

      if (late.length !== 0) { test.fail('an event was replayed to a late listener'); }

      events.purchase.emit({ item: 'shield' });
    })
    .thenIdle(10)
    .thenExecute(() => {
      if (late.length !== 1 || late[0] !== 'shield') { test.fail(`the late listener saw ${JSON.stringify(late)}`); }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// Config is a db document: a write to the accessor lands in the scope's collection, nested as the
// schema is; the document reads back with its defaults filled, and the bytes hold only overrides.
gametest('config_stores_through_db', (test) => {
  const addon = new Runtime();

  const { config } = addon.register({
    manifest: { creator: 'test', pack: 'cfg_db', packName: 'Cfg', version: '1.0.0' },
    config: {
      server: {
        economy: {
          taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax' },
          currency: { type: 'enum', default: 'emerald', options: ['emerald', 'gold'], label: 'Currency' },
        },
        tags: { type: 'list', itemType: 'string', default: [], label: 'Tags' },
      },
    },
  });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      config.server.economy.taxRate.set(0.2);
      config.server.tags.set(['a', 'b']);
      // Out of range: coerced to the entry's bounds on the way in.
      config.server.patch({ economy: { taxRate: 7 } });
    })
    .thenIdle(10)
    .thenExecute(() => {
      if (config.server.economy.taxRate.get() !== 1) { test.fail(`the write was not coerced: ${String(config.server.economy.taxRate.get())}`); }

      const collection = addon.db.find('config-server');

      if (collection === undefined) {
        test.fail('config did not declare a server collection on db');

        return;
      }

      const document = collection.for(world).get();

      if (JSON.stringify(document) !== JSON.stringify({ economy: { taxRate: 1, currency: 'emerald' }, tags: ['a', 'b'] })) {
        test.fail(`the document did not read back as the schema's shape: ${JSON.stringify(document)}`);
      }

      // Only overrides are stored, so a key left at its schema default is absent from the bytes —
      // which is what lets a later default change reach a world that never touched the setting.
      const key = `core-db:${addon.namespace}:world::config-server:doc`;
      const raw = world.getDynamicProperty(key);

      if (raw !== '{"v":1,"d":{"economy":{"taxRate":1},"tags":["a","b"]}}') {
        test.fail(`the stored bytes are not the overrides alone: ${String(raw)}`);
      }

      // Setting a group replaces it: the omitted key is back at its default, and gone from the bytes.
      config.server.economy.set({ taxRate: 0.05, currency: 'gold' });

      if (config.server.economy.taxRate.get() !== 0.05 || config.server.economy.currency.get() !== 'gold') {
        test.fail(`set on a group did not replace it: ${JSON.stringify(config.server.economy.get())}`);
      }

      if (world.getDynamicProperty(key) !== '{"v":1,"d":{"economy":{"currency":"gold"},"tags":["a","b"]}}') {
        test.fail(`a default was persisted: ${String(world.getDynamicProperty(key))}`);
      }

      addon.stop();
    })
    .thenSucceed();
});

// Config change notifications are observables: a leaf and the group above it both fire, with the
// previous value the observable held, and unsubscribing stops delivery.
gametest('config_subscribe_is_observable', (test) => {
  const addon = new Runtime();

  const { config } = addon.register({
    manifest: { creator: 'test', pack: 'cfg_obs', packName: 'Obs', version: '1.0.0' },
    config: {
      server: {
        economy: {
          taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax' },
        },
        label: { type: 'string', default: 'Shop', label: 'Label' },
      },
    },
  });

  const leaf: [number, number][] = [];
  const group: unknown[] = [];
  let afterRelease = 0;

  const release = config.server.economy.taxRate.subscribe((next, prev) => { leaf.push([next, prev]); });

  config.server.economy.subscribe((next) => { group.push(next); });
  // A sibling's listener hears nothing of the economy writes below.
  config.server.label.subscribe(() => { test.fail('a sibling group fired for an unrelated write'); });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => { config.server.economy.taxRate.set(0.2); })
    .thenIdle(5)
    .thenExecute(() => { config.server.economy.taxRate.set(0.3); })
    .thenIdle(5)
    .thenExecute(() => {
      release();
      config.server.economy.taxRate.set(0.4);
    })
    .thenIdle(5)
    .thenExecute(() => {
      afterRelease = leaf.length;

      if (leaf.length !== 2) { test.fail(`leaf fired ${leaf.length} times, expected 2`); }

      // The observable carries the value it held before, not undefined.
      if (leaf[0]?.[0] !== 0.2 || leaf[0]?.[1] !== 0.05) { test.fail(`first change was ${JSON.stringify(leaf[0])}`); }

      if (leaf[1]?.[0] !== 0.3 || leaf[1]?.[1] !== 0.2) { test.fail(`second change was ${JSON.stringify(leaf[1])}`); }

      // A group above a changed leaf is rebuilt and fires too.
      if (group.length !== 3) { test.fail(`group fired ${group.length} times, expected 3`); }

      if (JSON.stringify(group[0]) !== JSON.stringify({ taxRate: 0.2 })) {
        test.fail(`group saw ${JSON.stringify(group[0])}`);
      }

      // The released leaf listener heard nothing after unsubscribing, though the value did change.
      if (afterRelease !== 2) { test.fail('a released listener still fired'); }

      if (config.server.economy.taxRate.get() !== 0.4) { test.fail('the third write did not apply'); }

      addon.stop();
    })
    .thenSucceed();
});
