/**
 * S6 — what a shared delta costs on the bus.
 *
 * Three numbers gate work elsewhere: whether db collections can carry a `shared` cap
 * ([03-db](../../../../../../docs/03-db.md)), and whether a query's warm read from the mirror is
 * worth claiming ([04-query](../../../../../../docs/04-query.md)). Both hinge on whether a peer's
 * copy of a realistic value arrives soon enough to read, and on what the owner pays to publish it.
 *
 * Peers are separate `State` instances over their own `Bus`, all inside this script realm. They
 * talk through the engine's real `scriptEvent` transport, so serialization, the per-tick send
 * budget and delivery order are the engine's. What this does *not* separate is the QuickJS heap:
 * four packs would each parse their own copy, and that parse is counted once here. The apply and
 * convergence figures hold; treat the memory question as unmeasured.
 *
 * Every test prints `BENCH {...}` lines, which `scripts/bench-report.mjs` lifts out of the
 * transcript. Nothing is asserted except what would make a measurement meaningless.
 */
import { system } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import { Bus, State } from '@bedrock-core/sync';

const STRUCTURE = 'core:empty';

function benchmark(name: string, fn: (test: Test) => void): void {
  register('bench', name, fn).structureName(STRUCTURE).tag('bench').maxTicks(1200);
}

function report(name: string, data: Record<string, unknown>): void {
  console.warn(`BENCH ${JSON.stringify({ name, ...data })}`);
}

/**
 * A value of roughly `chars` characters, shaped like the nested JSON an addon would actually
 * share — a table of rows rather than one long string, so the parse cost is representative.
 */
function payload(chars: number): unknown {
  const rows: { id: number; key: string; value: number }[] = [];
  let length = 2;

  while (length < chars) {
    const row = { id: rows.length, key: `entry:${rows.length}:material`, value: rows.length * 7 };

    length += JSON.stringify(row).length + 1;
    rows.push(row);
  }

  return { ns: 'economy', rows };
}

const SIZES = [
  { label: '1KB', value: payload(1_000) },
  { label: '10KB', value: payload(10_000) },
];

interface Realm {
  id: string;
  bus: Bus;
  state: State;
}

/**
 * One realm: its own bus and state, started and ready to receive.
 *
 * An owner's id must BE the namespace it owns. A peer only applies a delta whose sender id equals
 * the namespace, which is how owner-only replication is enforced — a mismatch is silently treated
 * as a foreign write and dropped.
 */
function realm(id: string, owned: string[]): Realm {
  const bus = new Bus(id);
  const state = new State(bus, id, { ownedNamespaces: owned });

  bus.start();
  state.start();

  return { id, bus, state };
}

function stopAll(realms: Realm[]): void {
  for (const r of realms) {
    r.state.stop();
    r.bus.stop();
  }
}

/**
 * What the owner pays to publish, measured on its own tick.
 *
 * `set()` is synchronous: it stamps a version, applies locally and hands an envelope to the queue,
 * which serializes it. That whole cost lands on the caller's tick regardless of how many peers
 * are listening, so it is measured once per size rather than once per fan-out.
 */
benchmark('shared_publish', (test) => {
  const owner = realm('s6pub', ['s6pub']);
  const RUNS = 50;

  for (const { label, value } of SIZES) {
    const start = Date.now();

    for (let i = 0; i < RUNS; i++) { owner.state.set('s6pub', `k${i}`, value); }

    const ms = Date.now() - start;

    report('shared_publish', {
      payload: label,
      runs: RUNS,
      totalMs: ms,
      usPerSet: Math.round((ms * 1000) / RUNS),
    });
  }

  stopAll([owner]);
  test.succeed();
});

/**
 * How long a peer waits before it can read what the owner wrote, at two fan-outs.
 *
 * Convergence is reported as the worst peer, not the average: a warm read is only safe if *every*
 * mirror has the value, and a query that reads the slowest one is the one that returns stale data.
 */
function convergence(test: Test, peerCount: number): void {
  const ns = `s6c${peerCount}`;
  const owner = realm(ns, [ns]);
  const peers = Array.from({ length: peerCount }, (_, i) => realm(`s6_conv_peer_${peerCount}_${i}`, []));
  const all = [owner, ...peers];

  const seen = new Map<string, { ticks: number; ms: number }[]>();
  let sentTick = 0;
  let sentMs = 0;

  for (const peer of peers) {
    peer.state.subscribe((change) => {
      if (change.ns !== ns || typeof change.key !== 'string') { return; }

      const arrivals = seen.get(change.key) ?? [];

      arrivals.push({ ticks: system.currentTick - sentTick, ms: Date.now() - sentMs });
      seen.set(change.key, arrivals);
    });
  }

  const sequence = test.startSequence().thenIdle(20);

  for (const { label, value } of SIZES) {
    sequence
      .thenExecute(() => {
        sentTick = system.currentTick;
        sentMs = Date.now();
        owner.state.set(ns, label, value);
      })
      .thenIdle(60)
      .thenExecute(() => {
        const arrivals = seen.get(label) ?? [];
        const converged = arrivals.length === peerCount;

        report('shared_converge', {
          peers: peerCount,
          payload: label,
          arrived: arrivals.length,
          // The worst peer is the one a warm read has to wait for.
          ticks: converged ? Math.max(...arrivals.map(a => a.ticks)) : null,
          ms: converged ? Math.max(...arrivals.map(a => a.ms)) : null,
        });

        if (!converged) {
          test.fail(`${label} reached ${arrivals.length} of ${peerCount} peers — the transport dropped it`);
        }
      });
  }

  sequence
    .thenExecute(() => { stopAll(all); })
    .thenSucceed();
}

benchmark('shared_converge_2', test => convergence(test, 2));
benchmark('shared_converge_4', test => convergence(test, 4));

/**
 * Boot cost: an addon whose shared tree is `persisted` republishes every key a tick after
 * registration, so a hundred of them land together. That burst is the worst case the transport
 * sees in normal use, and it happens while the world is still loading.
 */
benchmark('shared_persist_boot', (test) => {
  const ns = 's6boot';
  const KEYS = 100;
  const owner = realm(ns, [ns]);
  const peer = realm('s6_boot_peer', []);
  const value = payload(200);

  let applied = 0;
  let startTick = 0;
  let startMs = 0;
  let lastTick = 0;
  let lastMs = 0;

  peer.state.subscribe((change) => {
    if (change.ns !== ns) { return; }

    applied++;
    lastTick = system.currentTick;
    lastMs = Date.now();
  });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      startTick = system.currentTick;
      startMs = Date.now();

      for (let i = 0; i < KEYS; i++) { owner.state.set(ns, `key:${i}`, value); }
    })
    .thenIdle(200)
    .thenExecute(() => {
      report('shared_persist_boot', {
        keys: KEYS,
        payload: '200B',
        applied,
        ticks: applied > 0 ? lastTick - startTick : null,
        ms: applied > 0 ? lastMs - startMs : null,
        // What a late joiner would have to replay to catch up.
        snapshotEntries: owner.state.snapshot(ns).length,
      });

      if (applied !== KEYS) { test.fail(`peer applied ${applied} of ${KEYS} keys`); }

      stopAll([owner, peer]);
    })
    .thenSucceed();
});
