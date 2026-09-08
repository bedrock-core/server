/**
 * GameTests for the bedrock-core stack. Most run several runtimes inside this one script
 * realm (they talk over the real `system` bus); the last asserts the separate "Shop" pack
 * (test-addon-2) is present, so it only passes when both addons are installed.
 *
 * Run in-game: `/gametest runset core` (or `/gametest run core:<name>`). The `bench` tag in
 * `./bench` is registered alongside them but runs only when asked for by name.
 */
import './bench';
import './bench-shared';
import { type Test, register } from '@minecraft/server-gametest';
import { Runtime, core, open, schema } from '@bedrock-core/server-runtime';

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

// A shared tree replicates between runtimes: the owner writes, a peer reads it typed, and a
// peer's write lands only on a leaf the owner opened.
gametest('shared_replication', (test) => {
  const a = new Runtime();
  const { shared } = a.register({ manifest: { creator: 'test', pack: 'shared_a', packName: 'A', version: '1.0.0' }, shared: { volume: 5, votes: open(0) } });
  const b = new Runtime();

  b.register({ manifest: { creator: 'test', pack: 'shared_b', packName: 'B', version: '1.0.0' } });

  shared.volume.set(7);
  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      const mirror = b.shared.of<{ volume: number; votes: ReturnType<typeof open<number>> }>(a.namespace);

      if (mirror === undefined) {
        test.fail('B never saw the shape');

        return;
      }

      if (mirror.volume.get() !== 7) { test.fail('volume did not replicate to B'); }

      mirror.votes.set(3);
      b.node.state.set(a.namespace, 'volume', 1);
    })
    .thenIdle(20)
    .thenExecute(() => {
      if (shared.votes.get() !== 3) { test.fail('an opened leaf did not take the peer write'); }

      if (shared.volume.get() !== 7) { test.fail('a closed leaf took a peer write'); }

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

// Cross-pack: the real "Shop" addon (test-addon-2) must be registered with our live core.
gametest('cross_pack_shop_present', (test) => {
  test.startSequence()
    .thenIdle(40)
    .thenExecute(() => {
      if (!core.registry.has('drav0011_shop')) {
        test.fail('shop addon not present — is test-addon-2 installed and enabled?');
      }
    })
    .thenSucceed();
});

// A collection's documents reach a peer through the shared mirror. The owner writes, and another
// runtime reads the announced value out of replicated state without any RPC — the warm read a
// cross-addon query is built on.
gametest('db_shared_announce', (test) => {
  const owner = new Runtime();

  owner.register({ manifest: { creator: 'test', pack: 'db_share_a', packName: 'A', version: '1.0.0' } });

  const peer = new Runtime();

  peer.register({ manifest: { creator: 'test', pack: 'db_share_b', packName: 'B', version: '1.0.0' } });

  const stats = owner.db.collection('stats', {
    schema: schema<{ score: number; log: string[] }>({ defaults: { score: 0, log: [] } }),
    shared: { as: doc => doc.score },
  });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      // The log is the bulk of the document and must never leave the owner.
      stats.for(test.getDimension()).set({ score: 42, log: ['a', 'b', 'c'] });
    })
    .thenIdle(20)
    .thenExecute(() => {
      const keys = peer.node.state.snapshot(owner.namespace).map(entry => entry.k);
      const announced = keys.filter(key => key.startsWith('core-db/stats/'));

      if (announced.length !== 1) {
        test.fail(`expected one announced document, saw ${announced.length}: ${keys.join(', ')}`);

        return;
      }

      const value = peer.node.state.get(owner.namespace, announced[0]);

      if (value !== 42) { test.fail(`peer saw ${JSON.stringify(value)}, expected the derived score 42`); }

      owner.stop();
      peer.stop();
    })
    .thenSucceed();
});

// A peer reads and writes another addon's document over `core:db.*`, addressed by the identity the
// index keeps. No actor rides along, so this is the programmatic addon-to-addon path.
gametest('db_rpc_cross_addon', (test) => {
  const owner = new Runtime();

  owner.register({ manifest: { creator: 'test', pack: 'db_rpc_a', packName: 'A', version: '1.0.0' } });

  const peer = new Runtime();

  peer.register({ manifest: { creator: 'test', pack: 'db_rpc_b', packName: 'B', version: '1.0.0' } });

  const notes = owner.db.collection('notes', {
    schema: schema<{ text: string; seen: number }>({ defaults: { text: '', seen: 0 } }),
  });

  const dimension = test.getDimension();

  notes.for(dimension).set({ text: 'hello', seen: 1 });

  let read: unknown;
  let patched: unknown;
  let refused: string | undefined;

  const address = { collection: 'notes', kind: 'dimension', identity: dimension.id };

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      void peer.rpc.request(owner.id, 'core:db.get', address).then((r) => { read = r; });
      void peer.rpc.request(owner.id, 'core:db.patch', { ...address, changes: { seen: 2 } })
        .then((r) => { patched = r; });
      void peer.rpc.request(owner.id, 'core:db.get', { ...address, collection: 'nope' })
        .catch((error: unknown) => { refused = String(error); });
    })
    .thenIdle(30)
    .thenExecute(() => {
      if (JSON.stringify(read) !== JSON.stringify({ text: 'hello', seen: 1 })) {
        test.fail(`peer read ${JSON.stringify(read)}`);
      }

      // The reply carries the document after the write, so no second round trip is needed.
      if (JSON.stringify(patched) !== JSON.stringify({ text: 'hello', seen: 2 })) {
        test.fail(`patch replied ${JSON.stringify(patched)}`);
      }

      // And the owner's own copy really changed.
      if (notes.for(dimension).get()?.seen !== 2) { test.fail('the owner document did not change'); }

      if (refused === undefined || !refused.includes('nope')) {
        test.fail(`an unknown collection should be refused by name, got ${String(refused)}`);
      }

      owner.stop();
      peer.stop();
    })
    .thenSucceed();
});
