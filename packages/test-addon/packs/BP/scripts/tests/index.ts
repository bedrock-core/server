/**
 * GameTests for the bedrock-core stack. Most run several runtimes inside this one script
 * realm (they talk over the real `system` bus); the last asserts the separate "Shop" pack
 * (test-addon-2) is present, so it only passes when both addons are installed.
 *
 * Run in-game: `/gametest runset bc` (or `/gametest run bc:<name>`).
 */
import { type Test, register } from '@minecraft/server-gametest';
import { Runtime, core } from '@bedrock-core/server-runtime';

const STRUCTURE = 'bc:empty';

function gametest(name: string, fn: (test: Test) => void): void {
  register('bc', name, fn).structureName(STRUCTURE).tag('bc').maxTicks(220);
}

// Two runtimes discover each other and complete an RPC round-trip. register() auto-starts.
gametest('discovery_and_rpc', (test) => {
  const a = new Runtime();

  a.register({ creator: 'test', pack: 'demo_a', packName: 'A', version: '1.0.0' });
  const b = new Runtime();

  b.register({ creator: 'test', pack: 'demo_b', packName: 'B', version: '1.0.0' });
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

  a.register({ creator: 'test', pack: 'self_rpc', packName: 'A', version: '1.0.0' });
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

// Shared state replicates between runtimes (last-write-wins, local reads).
gametest('state_replication', (test) => {
  const a = new Runtime();

  a.register({ creator: 'test', pack: 'state_a', packName: 'A', version: '1.0.0' });
  const b = new Runtime();

  b.register({ creator: 'test', pack: 'state_b', packName: 'B', version: '1.0.0' });

  a.state.set('volume', 7);
  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      if (b.node.state.get(a.namespace, 'volume') !== 7) { test.fail('state did not replicate to B'); }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// Same creator, different addon → distinct namespaces → coexist. Identical namespace → collision.
gametest('distinct_vs_collision', (test) => {
  const x = new Runtime();

  x.register({ creator: 'test', pack: 'dup_a', packName: 'X', version: '1.0.0' });
  const y = new Runtime();

  y.register({ creator: 'test', pack: 'dup_b', packName: 'Y', version: '1.0.0' });

  const c1 = new Runtime();

  c1.register({ creator: 'test', pack: 'clash_same', packName: 'First', version: '1.0.0' });
  let collided = false;

  c1.registry.onNamespaceCollision(() => { collided = true; });
  const c2 = new Runtime();

  c2.register({ creator: 'test', pack: 'clash_same', packName: 'Second', version: '1.0.0' });

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

  consumer.register({ creator: 'test', pack: 'game_main', packName: 'Game', version: '1.0.0', optionalDependencies: ['test_lb_main'] });

  let enabled = 0;

  consumer.features.add('lb-sync', { condition: r => r.registry.has('test_lb_main'), onEnable: () => enabled++, onDisable: () => { /* noop */ } });

  const provider = new Runtime();

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      if (enabled !== 0) { test.fail('feature enabled before its provider was present'); }

      provider.register({ creator: 'test', pack: 'lb_main', packName: 'Leaderboard', version: '1.0.0' });
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
      if (!core.registry.has('drav0011_bc_shop')) {
        test.fail('shop addon not present — is test-addon-2 installed and enabled?');
      }
    })
    .thenSucceed();
});
