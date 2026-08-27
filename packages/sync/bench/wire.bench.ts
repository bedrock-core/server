/**
 * Wire-path microbenchmarks: what one message costs in CPU on the send and receive sides.
 *
 * Run with `yarn workspace @bedrock-core/sync run bench`.
 *
 * These are off-engine numbers on a desktop JIT, not QuickJS on a console — read them as ratios
 * between payload sizes and between pipeline stages, never as a tick budget. The in-game suite is
 * what answers "does this fit in a tick".
 */
import { bench, describe } from 'vitest';
import { Reassembler } from '../src/chunk';
import { MAX_MESSAGE } from '../src/constants';
import { decodeEnvelope, encodeEnvelope } from '../src/envelope';
import { PAYLOADS, stateDeltaBurst } from './payloads';
import { envelopeFor, fromWire, packEnvelopes, toWire } from './pipeline';

for (const { label, value } of PAYLOADS) {
  const envelope = envelopeFor(value);
  const encoded = encodeEnvelope(envelope);
  const messages = toWire(envelope, MAX_MESSAGE);

  describe(label, () => {
    bench('encode envelope', () => {
      encodeEnvelope(envelope);
    });

    bench('decode envelope', () => {
      decodeEnvelope(encoded);
    });

    bench('encode to wire messages', () => {
      toWire(envelope, MAX_MESSAGE);
    });

    bench('decode from wire messages', () => {
      fromWire(messages, new Reassembler(), 0);
    });

    // The whole hop minus the engine: what a sender spends plus what a receiver spends.
    bench('round trip (send path → receive path)', () => {
      fromWire(toWire(envelope, MAX_MESSAGE), new Reassembler(), 0);
    });
  });
}

// Packing is the queue’s work, not the bus’s, and runs once per flush over whatever has piled up —
// so its cost scales with the burst, not with one message.
describe('packing', () => {
  const burst = stateDeltaBurst(40).map((data, i) => envelopeFor(data, `iid-1/${i}`));

  bench('pack a 40-delta burst', () => {
    packEnvelopes(burst, MAX_MESSAGE);
  });

  bench('unpack a 40-delta burst', () => {
    fromWire(packEnvelopes(burst, MAX_MESSAGE), new Reassembler(), 0);
  });
});
