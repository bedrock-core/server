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
 * Protocol cases share the current codec implementation rather than emulating older releases.
 */
import { system } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import { Bus, MAX_MESSAGE, capsFor } from '@bedrock-core/sync';
import { encodeEnvelope, decodeEnvelope, BENCH_PROTOCOLS as PROTOCOLS, STRUCTURED_PAYLOADS } from '@bedrock-core/server-test-fixtures/bench';

const STRUCTURE = 'core:empty';

/** Channel used by the raw probes, so they never disturb — or get disturbed by — the real bus. */
const PROBE_CHANNEL = 'bedrock-core:benchprobe';

function benchmark(name: string, fn: (test: Test) => void): void {
  register('bench', name, fn).batch(`bench_${name}`).structureName(STRUCTURE).tag('bench').maxTicks(1200);
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

interface Workload {
  label: string;
  value: unknown;
  protocol: number;
  format: string;
  valid?: (value: unknown) => boolean;
}

const WORKLOADS: readonly Workload[] = [
  ...PROTOCOLS.flatMap(protocol => SIZES.map(size => ({ ...size, protocol, format: 'JSON' }))),
  ...STRUCTURED_PAYLOADS.map(size => ({ ...size, protocol: 3, format: 'structured' })),
];

function validValue(workload: Workload, value: unknown): boolean {
  return workload.valid ? workload.valid(value) : JSON.stringify(value) === JSON.stringify(workload.value);
}

function connect(a: Bus, b: Bus, protocol: number): void {
  a.setPeerProtocol(b.selfId, protocol, capsFor(protocol, undefined));
  b.setPeerProtocol(a.selfId, protocol, capsFor(protocol, undefined));
}

function receivedValue(data: unknown): unknown {
  return typeof data === 'object' && data !== null && 'value' in data ? data.value : undefined;
}

// Serialization runs on the calling tick, so a payload whose encode does not fit in a tick cannot
// be sent at all, whatever the transport does with it afterwards.
benchmark('serialize', (test) => {
  for (const workload of WORKLOADS) {
    const { label, value, protocol, format } = workload;
    const envelope = { v: protocol, src: 'bench', iid: 'bench-1', type: 'bench', mid: 'bench-1/1', data: value };
    const runs = label === '16KB' ? 10 : 100;
    const decoded = decodeEnvelope(encodeEnvelope(envelope));

    test.assert(decoded?.v === protocol && validValue(workload, decoded.data), `${format} ${label} must round trip at v${protocol}`);

    const encodeStart = Date.now();
    let encoded = '';

    for (let i = 0; i < runs; i++) { encoded = encodeEnvelope(envelope); }

    const encodeMs = Date.now() - encodeStart;
    const decodeStart = Date.now();

    for (let i = 0; i < runs; i++) { decodeEnvelope(encoded); }

    report('serialize', {
      payload: label,
      protocol,
      format,
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
  const results = new Map<string, { ticks: number; ms: number; protocol: number; value: unknown }>();

  b.on('bench-latency', (envelope) => {
    const label = labelOf(envelope.data);
    const sent = label === undefined ? undefined : sentAt.get(label);

    if (!sent || label === undefined) { return; }

    results.set(label, {
      ticks: system.currentTick - sent.tick,
      ms: Date.now() - sent.ms,
      protocol: envelope.v,
      value: receivedValue(envelope.data),
    });
  });

  const sequence = test.startSequence().thenIdle(20);

  for (const workload of WORKLOADS) {
    const { label, value, protocol, format } = workload;
    const key = `${protocol}:${label}`;

    sequence
      .thenExecute(() => {
        connect(a, b, protocol);
        sentAt.set(key, { tick: system.currentTick, ms: Date.now() });
        a.send({ dst: b.selfId, type: 'bench-latency', data: { label: key, value } });
      })
      .thenIdle(20)
      .thenExecute(() => {
        const result = results.get(key);

        if (!result || result.protocol !== a.broadcastProtocol || result.protocol !== protocol || !validValue(workload, result.value)) {
          a.stop();
          b.stop();
          test.fail(`v${protocol} ${label} did not arrive intact`);

          return;
        }

        report('send_latency', { payload: label, protocol: a.broadcastProtocol, format, ticks: result.ticks, ms: result.ms });
      });
  }

  sequence
    .thenExecute(() => {
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

  const cases: readonly Workload[] = [
    ...PROTOCOLS.map(protocol => ({ label: '16KB', value: LARGE, protocol, format: 'JSON' })),
    { ...STRUCTURED_PAYLOADS[1], protocol: 3, format: 'structured' },
  ];
  const arrivals = new Map<string, {
    startTick: number;
    startMs: number;
    lastTick: number;
    lastMs: number;
    values: Map<number, { protocol: number; value: unknown }>;
  }>();

  b.on('bench-bp', (envelope) => {
    const label = labelOf(envelope.data);
    const current = label === undefined ? undefined : arrivals.get(label);
    const data = envelope.data;

    if (!current || typeof data !== 'object' || data === null || !('i' in data)
      || typeof data.i !== 'number' || data.i < 0 || data.i >= 3) { return; }

    current.lastTick = system.currentTick;
    current.lastMs = Date.now();
    current.values.set(data.i, { protocol: envelope.v, value: receivedValue(data) });
  });

  const sequence = test.startSequence().thenIdle(20);

  for (const workload of cases) {
    const { label, value, protocol, format } = workload;
    const key = `${protocol}:${label}`;

    sequence
      .thenExecute(() => {
        connect(a, b, protocol);
        arrivals.set(key, { startTick: system.currentTick, startMs: Date.now(), lastTick: 0, lastMs: 0, values: new Map() });

        for (let i = 0; i < 3; i++) { a.send({ dst: b.selfId, type: 'bench-bp', data: { label: key, i, value } }); }
      })
      .thenIdle(120)
      .thenExecute(() => {
        const current = arrivals.get(key)!;

        report('backpressure', {
          concurrent: 3,
          payload: label,
          protocol: a.broadcastProtocol,
          format,
          received: current.values.size,
          ticks: current.values.size > 0 ? current.lastTick - current.startTick : null,
          ms: current.values.size > 0 ? current.lastMs - current.startMs : null,
        });

        if (current.values.size !== 3 || [...current.values.values()].some(result => result.protocol !== protocol || !validValue(workload, result.value))) {
          a.stop();
          b.stop();
          test.fail(`v${protocol} ${label} did not deliver three intact payloads`);
        }
      });
  }

  sequence
    .thenExecute(() => {
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
  const receivedProtocols = new Set<number>();

  const probe = system.afterEvents.scriptEventReceive.subscribe(
    (event) => {
      if (event.message.includes('bench-pack')) { messagesOnWire++; }
    },
    { namespaces: ['bedrock-core'] },
  );

  b.on('bench-pack', (envelope) => { envelopesDelivered++; receivedProtocols.add(envelope.v); });

  const sequence = test.startSequence().thenIdle(20);

  for (const protocol of PROTOCOLS) {
    sequence
      .thenExecute(() => {
        connect(a, b, protocol);
        messagesOnWire = 0;
        envelopesDelivered = 0;
        receivedProtocols.clear();

        for (let i = 0; i < BURST; i++) {
          a.send({ type: 'bench-pack', data: { ns: 'economy', key: `price:${i}`, value: 16 + i, ver: 1200 + i } });
        }
      })
      .thenIdle(40)
      .thenExecute(() => {
        report('packing', {
          protocol: a.broadcastProtocol,
          envelopesSent: BURST,
          messagesOnWire,
          envelopesDelivered,
          envelopesPerMessage: messagesOnWire > 0 ? Number((envelopesDelivered / messagesOnWire).toFixed(2)) : null,
        });

        if (envelopesDelivered !== BURST || receivedProtocols.size !== 1 || !receivedProtocols.has(protocol) || messagesOnWire < 1
          || (protocol === 1 ? messagesOnWire !== BURST : messagesOnWire >= BURST)) {
          system.afterEvents.scriptEventReceive.unsubscribe(probe);
          a.stop();
          b.stop();
          test.fail(`v${protocol} did not deliver and pack the ${BURST}-envelope burst correctly`);
        }
      });
  }

  sequence
    .thenExecute(() => {
      system.afterEvents.scriptEventReceive.unsubscribe(probe);
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
