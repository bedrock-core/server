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
import { Bus, MAX_MESSAGE, SyncNode, type ReplicaSubscription } from '@bedrock-core/sync';
import { core } from '@bedrock-core/server-runtime';
import { PEER_ECHO_MODULE, peerEchoShape, type PeerEcho, type StructuredPayload } from '@bedrock-core/server-test-fixtures/peer-contract';

const STRUCTURE = 'core:empty';

gametest('cross_pack_structured_values', (test) => {
  const key = { id: 'player' };
  const buffer = new ArrayBuffer(12);
  const bytes = new Uint8Array(buffer, 4, 4);
  const pattern = /items/gi;
  const value: StructuredPayload = { key, map: new Map([[key, new Set([key])]]), missing: undefined, numbers: [NaN, Infinity, -Infinity, -0],
    exact: BigInt('9007199254740993'), date: new Date('2026-11-09T00:00:00Z'), pattern, buffer, bytes, view: new DataView(buffer, 4, 4), text: 'structured'.repeat(1000) };

  value.self = value;
  bytes.set([1, 2, 3, 4]);
  pattern.lastIndex = 3;
  const peer = core.api.createModule<PeerEcho>('core_fixture_peer', PEER_ECHO_MODULE, peerEchoShape);
  let reply: StructuredPayload | undefined;
  let failure: unknown;

  test.startSequence()
    .thenExecute(() => { void peer.structured(value).then((result) => { reply = result; }, (error) => { failure = error; }); })
    .thenIdle(70)
    .thenExecute(() => {
      test.assert(failure === undefined && reply !== undefined, 'the structured request returned: ' + String(failure));

      if (!reply) { return; }

      test.assert(reply.self === reply && reply.map.get(reply.key)?.has(reply.key) === true, 'cycles, collection keys and aliases survive both pack boundaries');
      test.assert(Object.hasOwn(reply, 'missing') && reply.missing === undefined, 'undefined properties stay present');
      test.assert(Number.isNaN(reply.numbers[0]) && reply.numbers[1] === Infinity && reply.numbers[2] === -Infinity && Object.is(reply.numbers[3], -0), 'special numbers stay exact');
      test.assert(reply.exact === value.exact && reply.date.getTime() === value.date.getTime(), 'big integers and dates retain their values');
      test.assert(reply.pattern.source === pattern.source && reply.pattern.flags === pattern.flags && reply.pattern.lastIndex === 3, 'regular expressions retain their state');
      test.assert(reply.bytes.buffer === reply.buffer && reply.view.buffer === reply.buffer && reply.bytes.byteOffset === 4 && reply.view.getUint8(0) === 1, 'binary views retain their shared buffer and offsets');
      test.assert(reply.text === value.text, 'the chunked text is complete');
    })
    .thenSucceed();
});

gametest('sync_replication_snapshots', (test) => {
  const owner = new SyncNode({ id: 'sync_replica_owner' });
  const reader = new SyncNode({ id: 'sync_replica_reader' });
  const text = 'replication'.repeat(1000);
  const exact = BigInt('9007199254740993');
  const value = new Map<string, unknown>([['text', text], ['exact', exact], ['items', new Set(['stone'])]]);
  let watch: ReplicaSubscription | undefined;

  owner.start();
  const publication = owner.replication.publish('fixture', value);

  test.startSequence()
    .thenIdle(12)
    .thenExecute(() => { reader.start(); })
    .thenIdle(12)
    .thenExecute(() => { watch = reader.replication.watch(owner.id, owner.bus.instanceId, 'fixture'); })
    .thenIdle(35)
    .thenExecute(() => {
      const snapshot = watch?.snapshot.get();
      const received = snapshot?.value;

      test.assert(snapshot?.status === 'ready' && received instanceof Map, 'the late watch receives the chunked structured publication');

      if (received instanceof Map) {
        const items: unknown = received.get('items');

        test.assert(received.get('text') === text && received.get('exact') === exact && items instanceof Set && items.has('stone'), 'replicated collections and exact numbers retain their values');
      }

      publication.set('updated');
    })
    .thenIdle(12)
    .thenExecute(() => {
      test.assert(watch?.snapshot.get().value === 'updated', 'broadcast replacements update the retained snapshot');
      publication.stop();
    })
    .thenIdle(12)
    .thenExecute(() => {
      test.assert(watch?.snapshot.get().status === 'missing', 'withdrawal clears the remote value');
      owner.replication.publish('fixture', 'replacement');
    })
    .thenIdle(12)
    .thenExecute(() => {
      try {
        test.assert(watch?.snapshot.get().value === 'replacement', 'a new publication generation replaces the withdrawn value');
      } finally { reader.stop(); owner.stop(); }

      test.assert(watch?.snapshot.get().status === 'stopped', 'SyncNode shutdown releases its watch handles');
    })
    .thenSucceed();
});

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
 * between two sync nodes rather than two bare buses, which would never have met.
 */
gametest('sync_batch_packing', (test) => {
  const a = new SyncNode({ id: 'test_pack_burst_a' });
  const b = new SyncNode({ id: 'test_pack_burst_b' });

  a.start();
  b.start();
  const BURST = 40;
  let delivered = 0;
  let messages = 0;

  let stopProbe = (): void => {};

  b.bus.on('fixture-packed', () => { delivered++; });

  test.startSequence()
    .thenIdle(30)
    .thenExecute(() => {
      if (a.discovery.getPeer(b.id) === undefined) { test.fail('the two nodes never met, so nothing could be negotiated'); }

      // Counted from here, so the announces that did the negotiating are not in the total.
      stopProbe = wireProbe(a.bus.instanceId, () => { messages++; });

      for (let i = 0; i < BURST; i++) { a.bus.send({ type: 'fixture-packed', data: { key: `price:${i}`, value: 16 + i } }); }
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
  const owner = new SyncNode({ id: 'test_late_owner' });
  let late: SyncNode | undefined;
  const volumes: (number | undefined)[] = [];
  let releaseVolume: (() => void) | undefined;

  owner.start();
  owner.state.observe(owner.id, 'unpublished');
  owner.state.set(owner.id, 'volume', 11);
  owner.state.set(owner.id, 'motd', 'loud');
  owner.state.set(owner.id, 'removed', true);
  owner.state.delete(owner.id, 'removed');

  test.startSequence()
    .thenIdle(30)
    .thenExecute(() => {
      // Every delta is long gone by the time this node exists.
      late = new SyncNode({ id: 'test_late_joiner' });
      releaseVolume = late.state.observe<number>(owner.id, 'volume').subscribe(value => volumes.push(value));
      late.start();
    })
    .thenIdle(40)
    .thenExecute(() => {
      const volume = late?.state.get(owner.id, 'volume');
      const motd = late?.state.get(owner.id, 'motd');

      if (volume !== 11 || motd !== 'loud') {
        test.fail(`the snapshot rebuilt ${JSON.stringify({ volume, motd })}`);
      }

      if (volumes.length !== 1 || volumes[0] !== 11) { test.fail('the observable did not receive the snapshot value exactly once'); }

      const entries = late?.state.snapshot(owner.id) ?? [];

      if (entries.length !== 3 || !entries.some(entry => entry.k === 'removed' && entry.del === true)) {
        test.fail('the snapshot must retain the deletion and omit the unpublished observed key');
      }

      releaseVolume?.();
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
  const peer = core.api.createModule<PeerEcho>('core_fixture_peer', PEER_ECHO_MODULE, peerEchoShape);

  test.startSequence()
    .thenIdle(40)
    .thenExecute(() => {
      if (!core.registry.has('core_fixture_peer')) {
        test.fail('peer pack not present — is core-server-fixture-peer installed and enabled?');

        return;
      }

      void peer.echo(value)
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
