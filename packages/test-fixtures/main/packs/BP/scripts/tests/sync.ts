/**
 * GameTests for `@bedrock-core/sync` — what only the engine's own transport can answer.
 *
 * `packages/sync/test` drives the bus through a fake script-event channel, so framing,
 * reassembly and packing are proven against sync's idea of the engine. These tests put the same
 * traffic on the real channel: a payload larger than one message, the same payload in characters
 * the engine may count in bytes rather than UTF-16 units, a burst that has to pack, a mirror
 * built from a snapshot rather than a delta, and one round trip that leaves this script realm
 * for the peer pack and comes back.
 *
 * The single-realm tests in `./index` cover discovery, RPC and replication between runtimes that
 * share a heap; nothing here duplicates them.
 */
import { system } from '@minecraft/server';
import { type Test, register } from '@minecraft/server-gametest';
import { Bus, MAX_MESSAGE } from '@bedrock-core/sync';
import { Runtime, core, registerShared } from '@bedrock-core/server-runtime';

const STRUCTURE = 'core:empty';

function gametest(name: string, fn: (test: Test) => void): void {
  register('core', name, fn).structureName(STRUCTURE).tag('core').maxTicks(400);
}

/**
 * A payload of roughly `chars` characters made of `unit`, shaped like the nested JSON addons
 * exchange rather than one long string, so the encode and the split are representative.
 */
function payload(chars: number, unit: string): { ns: string; rows: { id: number; text: string }[] } {
  const rows: { id: number; text: string }[] = [];
  let length = 2;

  while (length < chars) {
    const row = { id: rows.length, text: unit.repeat(8) };

    length += JSON.stringify(row).length + 1;
    rows.push(row);
  }

  return { ns: 'fixture', rows };
}

/** A cheap checksum over a value's JSON, so a reassembly that lost or reordered a frame shows. */
function checksum(value: unknown): number {
  const json = JSON.stringify(value);
  let sum = 0;

  for (let i = 0; i < json.length; i++) { sum = (sum * 31 + json.charCodeAt(i)) % 2_147_483_647; }

  return sum;
}

/** Count the messages one node puts on the bus channel: every frame carries its instance id. */
function wireProbe(instanceId: string, count: () => void): () => void {
  const handler = system.afterEvents.scriptEventReceive.subscribe(
    (event) => { if (event.message.includes(instanceId)) { count(); } },
    { namespaces: ['bedrock-core'] },
  );

  return (): void => system.afterEvents.scriptEventReceive.unsubscribe(handler);
}

/**
 * A payload larger than one script-event message crosses whole. The frame count is asserted too:
 * a cap that grew would make this a single message and quietly stop testing reassembly.
 */
gametest('sync_chunked_roundtrip', (test) => {
  const sender = new Bus('sync_chunk_a', { instanceId: 'fixture-chunk-a' });
  const receiver = new Bus('sync_chunk_b', { instanceId: 'fixture-chunk-b' });
  const value = payload(16_000, 'a');
  let received: unknown;
  let messages = 0;

  sender.start();
  receiver.start();
  receiver.on('fixture-chunked', (envelope) => { received = envelope.data; });

  const stopProbe = wireProbe('fixture-chunk-a', () => { messages++; });

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => { sender.send({ type: 'fixture-chunked', data: value }); })
    .thenIdle(40)
    .thenExecute(() => {
      stopProbe();
      sender.stop();
      receiver.stop();

      if (received === undefined) {
        test.fail(`a ${JSON.stringify(value).length}-character payload never arrived`);

        return;
      }

      if (checksum(received) !== checksum(value)) { test.fail('the payload was reassembled wrong'); }

      if (messages < 2) { test.fail(`the payload went out in ${messages} message(s) — it is no longer being split`); }
    })
    .thenSucceed();
});

/**
 * The same, in characters that are one UTF-16 unit and three UTF-8 bytes. sync budgets a message
 * in string length; if the engine's cap is really bytes, every frame here is three times over it
 * and nothing arrives — which is a bug in the library, not in the test.
 */
gametest('sync_unicode_roundtrip', (test) => {
  const sender = new Bus('sync_uni_a', { instanceId: 'fixture-uni-a' });
  const receiver = new Bus('sync_uni_b', { instanceId: 'fixture-uni-b' });
  const value = payload(MAX_MESSAGE * 3, '漢');
  let received: unknown;

  sender.start();
  receiver.start();
  receiver.on('fixture-unicode', (envelope) => { received = envelope.data; });

  test.startSequence()
    .thenIdle(10)
    .thenExecute(() => { sender.send({ type: 'fixture-unicode', data: value }); })
    .thenIdle(40)
    .thenExecute(() => {
      sender.stop();
      receiver.stop();

      if (received === undefined) {
        test.fail('a non-ASCII payload never arrived — the engine is not counting the same units sync is');

        return;
      }

      if (checksum(received) !== checksum(value)) { test.fail('a non-ASCII payload was reassembled wrong'); }
    })
    .thenSucceed();
});

/**
 * A burst of small messages is packed into fewer script events than it has envelopes. Packing is
 * negotiated — a sender only packs for readers that announced they can unpack — so this runs
 * between two runtimes rather than two bare buses, which would never have met.
 */
gametest('sync_batch_packing', (test) => {
  const a = new Runtime();
  const b = new Runtime();

  a.register({ manifest: { creator: 'test', pack: 'pack_burst_a', packName: 'A', version: '1.0.0' } });
  b.register({ manifest: { creator: 'test', pack: 'pack_burst_b', packName: 'B', version: '1.0.0' } });
  const BURST = 40;
  let delivered = 0;
  let messages = 0;

  let stopProbe = (): void => {};

  b.node.bus.on('fixture-packed', () => { delivered++; });

  test.startSequence()
    .thenIdle(30)
    .thenExecute(() => {
      if (!a.registry.has(b.id)) { test.fail('the two runtimes never met, so nothing could be negotiated'); }

      // Counted from here, so the announces that did the negotiating are not in the total.
      stopProbe = wireProbe(a.node.bus.instanceId, () => { messages++; });

      for (let i = 0; i < BURST; i++) { a.node.bus.send({ type: 'fixture-packed', data: { key: `price:${i}`, value: 16 + i } }); }
    })
    .thenIdle(40)
    .thenExecute(() => {
      stopProbe();
      a.stop();
      b.stop();

      if (delivered !== BURST) { test.fail(`${delivered} of ${BURST} envelopes arrived`); }

      if (messages >= BURST) { test.fail(`${BURST} envelopes went out in ${messages} messages — nothing was packed`); }
    })
    .thenSucceed();
});

/**
 * A node that starts after everything was already said builds its mirror from a snapshot, not
 * from deltas it never heard. This is the path every addon takes that is enabled mid-world.
 */
gametest('sync_late_joiner_snapshot', (test) => {
  const owner = new Runtime();
  const { shared: own } = owner.register({
    manifest: { creator: 'test', pack: 'late_owner', packName: 'Owner', version: '1.0.0' },
    shared: registerShared({ volume: 1, motd: 'quiet' }),
  });
  let late: Runtime | undefined;

  own.volume.set(11);
  own.motd.set('loud');

  test.startSequence()
    .thenIdle(30)
    .thenExecute(() => {
      // Every delta is long gone by the time this node exists.
      late = new Runtime();
      late.register({ manifest: { creator: 'test', pack: 'late_joiner', packName: 'Joiner', version: '1.0.0' } });
    })
    .thenIdle(40)
    .thenExecute(() => {
      const mirror = late?.shared.of<{ volume: number; motd: string }>(owner.namespace);

      if (mirror === undefined) {
        test.fail('the late node never saw the shape');
      } else if (mirror.volume.get() !== 11 || mirror.motd.get() !== 'loud') {
        test.fail(`the snapshot rebuilt ${JSON.stringify({ volume: mirror.volume.get(), motd: mirror.motd.get() })}`);
      }

      owner.stop();
      late?.stop();
    })
    .thenSucceed();
});

/**
 * The only round trip that leaves this script realm: a chunked request to the peer pack, whose
 * `echo` answers with what it reassembled. Two packs, two QuickJS heaps, one wire — the case an
 * in-realm test cannot reach, since both ends there share a heap and a protocol by construction.
 */
gametest('cross_pack_rpc_chunked', (test) => {
  const value = payload(8_000, 'b');
  const expected = { chars: JSON.stringify(value).length, sum: checksum(value) };
  let reply: unknown;
  let failure: string | undefined;

  test.startSequence()
    .thenIdle(40)
    .thenExecute(() => {
      if (!core.registry.has('core_fixture_peer')) {
        test.fail('peer pack not present — is core-server-fixture-peer installed and enabled?');

        return;
      }

      void core.rpc.request('core_fixture_peer', 'echo', value)
        .then((r) => { reply = r; })
        .catch((error: unknown) => { failure = String(error); });
    })
    .thenIdle(60)
    .thenExecute(() => {
      if (failure !== undefined) {
        test.fail(`the peer pack refused the request: ${failure}`);

        return;
      }

      if (JSON.stringify(reply) !== JSON.stringify(expected)) {
        test.fail(`the peer pack answered ${JSON.stringify(reply)}, expected ${JSON.stringify(expected)}`);
      }
    })
    .thenSucceed();
});
