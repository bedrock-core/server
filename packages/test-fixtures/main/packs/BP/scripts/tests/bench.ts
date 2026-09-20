/**
 * In-game benchmarks for the sync transport, run under the `bench` tag rather than `core`.
 *
 * These are kept out of the correctness suite for two reasons: they are slow, and a number that
 * moves is not a failure. `yarn test:mc` has to stay a red/green signal, so nothing here is
 * asserted except the properties that would make a measurement meaningless. Each test prints one
 * `BENCH {...}` line, which `scripts/bench-report.mjs` lifts out of the server transcript.
 *
 * Why measure in the engine when `packages/sync/bench` already measures off it: QuickJS on a
 * server is not V8 on a desktop, the tick loop is real, and the engine's own limits — the per-tick
 * script-event budget, the size cap on one message — exist nowhere else. The off-engine numbers
 * say which approach is cheaper; these say whether it fits.
 */
import { system } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import { Bus, MAX_MESSAGE } from '@bedrock-core/sync';

const STRUCTURE = 'core:empty';

/** Channel used by the raw probes, so they never disturb — or get disturbed by — the real bus. */
const PROBE_CHANNEL = 'bedrock-core:benchprobe';

function benchmark(name: string, fn: (test: Test) => void): void {
  register('bench', name, fn).structureName(STRUCTURE).tag('bench').maxTicks(1200);
}

/** One machine-readable result line. `scripts/bench-report.mjs` parses these out of the log. */
function report(name: string, data: Record<string, unknown>): void {
  console.warn(`BENCH ${JSON.stringify({ name, ...data })}`);
}

/**
 * A payload of roughly `chars` characters, shaped like the nested JSON addons actually exchange.
 *
 * The running length is accumulated per row rather than re-measured from the whole array, since
 * this builds at module load — on the engine, where a quadratic loop is a hitch on the tick that
 * loads the pack.
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

/** Read the size label back off a received payload without asserting a shape onto unknown data. */
function labelOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('label' in data)) { return undefined; }

  const { label } = data;

  return typeof label === 'string' ? label : undefined;
}

const LARGE = payload(16_000);

const SIZES = [
  { label: '5B', value: 'hello' },
  { label: '200B', value: payload(200) },
  { label: '16KB', value: LARGE },
];

// Serialization runs on the calling tick, so a payload whose encode does not fit in a tick cannot
// be sent at all, whatever the transport does with it afterwards.
benchmark('serialize', (test) => {
  for (const { label, value } of SIZES) {
    const envelope = { v: 2, src: 'bench', iid: 'bench-1', type: 'bench', mid: 'bench-1/1', data: value };
    const runs = label === '16KB' ? 10 : 100;

    const encodeStart = Date.now();
    let encoded = '';

    for (let i = 0; i < runs; i++) { encoded = JSON.stringify(envelope); }

    const encodeMs = Date.now() - encodeStart;
    const decodeStart = Date.now();

    for (let i = 0; i < runs; i++) { JSON.parse(encoded); }

    report('serialize', {
      payload: label,
      runs,
      chars: encoded.length,
      encodeMs,
      decodeMs: Date.now() - decodeStart,
    });
  }

  test.succeed();
});

// End-to-end latency in ticks. The queue never sends inline, so the floor is one flush plus the
// engine's delivery — the number worth knowing, since it bounds every RPC round trip.
benchmark('send_latency', (test) => {
  const a = new Bus('bench_send_a');
  const b = new Bus('bench_send_b');

  a.start();
  b.start();

  const sentAt = new Map<string, { tick: number; ms: number }>();
  const results: Record<string, unknown>[] = [];

  b.on('bench-latency', (envelope) => {
    const label = labelOf(envelope.data);
    const sent = label === undefined ? undefined : sentAt.get(label);

    if (!sent || label === undefined) { return; }

    results.push({
      payload: label,
      ticks: system.currentTick - sent.tick,
      ms: Date.now() - sent.ms,
    });
  });

  const sequence = test.startSequence().thenIdle(20);

  for (const { label, value } of SIZES) {
    sequence
      .thenExecute(() => {
        sentAt.set(label, { tick: system.currentTick, ms: Date.now() });
        a.send({ type: 'bench-latency', data: { label, value } });
      })
      .thenIdle(20);
  }

  sequence
    .thenExecute(() => {
      for (const result of results) { report('send_latency', result); }

      if (results.length !== SIZES.length) {
        test.fail(`only ${results.length} of ${SIZES.length} payloads arrived`);
      }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// Three large payloads at once. Each one chunks, so this is really a question about the per-tick
// send budget: whether the queue drains them together or spreads them across flushes.
benchmark('backpressure', (test) => {
  const a = new Bus('bench_bp_a');
  const b = new Bus('bench_bp_b');

  a.start();
  b.start();

  let startTick = 0;
  let startMs = 0;
  let received = 0;
  let lastTick = 0;
  let lastMs = 0;

  b.on('bench-bp', () => {
    received++;
    lastTick = system.currentTick;
    lastMs = Date.now();
  });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      startTick = system.currentTick;
      startMs = Date.now();

      for (let i = 0; i < 3; i++) { a.send({ type: 'bench-bp', data: { i, value: LARGE } }); }
    })
    .thenIdle(120)
    .thenExecute(() => {
      report('backpressure', {
        concurrent: 3,
        payload: '16KB',
        received,
        ticks: received > 0 ? lastTick - startTick : null,
        ms: received > 0 ? lastMs - startMs : null,
      });

      if (received !== 3) { test.fail(`only ${received} of 3 large payloads arrived`); }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// Does the queue's packing survive contact with the engine? Counts the script events one node's
// burst of small messages actually puts on the wire.
benchmark('packing', (test) => {
  const a = new Bus('bench_pack_a');
  const b = new Bus('bench_pack_b');

  a.start();
  b.start();

  const BURST = 40;
  let messagesOnWire = 0;
  let envelopesDelivered = 0;

  const probe = system.afterEvents.scriptEventReceive.subscribe(
    (event) => {
      if (event.message.includes('bench-pack')) { messagesOnWire++; }
    },
    { namespaces: ['bedrock-core'] },
  );

  b.on('bench-pack', () => { envelopesDelivered++; });

  test.startSequence()
    .thenIdle(20)
    .thenExecute(() => {
      for (let i = 0; i < BURST; i++) {
        a.send({ type: 'bench-pack', data: { ns: 'economy', key: `price:${i}`, value: 16 + i, ver: 1200 + i } });
      }
    })
    .thenIdle(40)
    .thenExecute(() => {
      report('packing', {
        envelopesSent: BURST,
        messagesOnWire,
        envelopesDelivered,
        envelopesPerMessage: messagesOnWire > 0 ? Number((envelopesDelivered / messagesOnWire).toFixed(2)) : null,
      });

      system.afterEvents.scriptEventReceive.unsubscribe(probe);

      if (envelopesDelivered !== BURST) { test.fail(`delivered ${envelopesDelivered} of ${BURST} envelopes`); }

      a.stop();
      b.stop();
    })
    .thenSucceed();
});

// Mojang documents the cap as 2048 *characters*. sync counts JavaScript string length, which is
// UTF-16 code units — so if the engine is really counting UTF-8 bytes, a message of non-ASCII text
// passes every check in the library and is rejected at send, where the queue can do nothing but
// count it as dropped. That is a correctness question with a measurable answer, so it is measured.
benchmark('message_cap_units', (test) => {
  const cases = [
    { label: 'ascii', text: 'a'.repeat(MAX_MESSAGE), bytesPerUnit: 1 },
    { label: 'latin1', text: 'é'.repeat(MAX_MESSAGE), bytesPerUnit: 2 },
    { label: 'cjk', text: '漢'.repeat(MAX_MESSAGE), bytesPerUnit: 3 },
    // An emoji is two UTF-16 units, so half as many of them reach the same string length.
    { label: 'astral', text: '🧱'.repeat(MAX_MESSAGE / 2), bytesPerUnit: 2 },
  ];

  const arrived = new Set<string>();
  const threw = new Map<string, string>();

  const probe = system.afterEvents.scriptEventReceive.subscribe(
    (event) => {
      if (event.id !== PROBE_CHANNEL) { return; }

      for (const { label, text } of cases) {
        if (event.message.length === text.length && event.message[0] === text[0]) { arrived.add(label); }
      }
    },
    { namespaces: ['bedrock-core'] },
  );

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => {
      for (const { label, text } of cases) {
        try {
          system.sendScriptEvent(PROBE_CHANNEL, text);
        } catch (error) {
          threw.set(label, String(error));
        }
      }
    })
    .thenIdle(40)
    .thenExecute(() => {
      for (const { label, text, bytesPerUnit } of cases) {
        report('message_cap_units', {
          encoding: label,
          stringLength: text.length,
          approxUtf8Bytes: text.length * bytesPerUnit,
          sendThrew: threw.get(label) ?? null,
          arrived: arrived.has(label),
        });
      }

      system.afterEvents.scriptEventReceive.unsubscribe(probe);

      // The ASCII control has to survive, or the probe itself is broken and the other rows mean
      // nothing. The non-ASCII rows are the measurement and are deliberately not asserted.
      if (!arrived.has('ascii')) { test.fail('the ASCII control did not arrive — the probe is broken'); }
    })
    .thenSucceed();
});
