/**
 * Wire-path microbenchmarks: what one message costs in CPU on the send and receive sides.
 *
 * Run with `yarn workspace @bedrock-core/sync run bench`.
 *
 * These are off-engine numbers on a desktop JIT, not QuickJS on a console — read them as ratios
 * between payload sizes and between pipeline stages, never as a tick budget. The in-game suite is
 * what answers "does this fit in a tick".
 * All protocol cases use the current codec; they compare wire formats, not historical releases.
 */
import { bench, describe, expect } from 'vitest';
import { Reassembler } from '../src/chunk';
import { MAX_MESSAGE } from '../src/constants';
import { decodeEnvelope, encodeEnvelope } from '../src/envelope';
import { PAYLOADS, stateDeltaBurst } from './payloads';
import { envelopeFor, fromWire, packEnvelopes, PROTOCOLS, toWire } from './pipeline';
import { STRUCTURED_PAYLOADS } from './structured';

const cases = [
  ...PROTOCOLS.flatMap(protocol => PAYLOADS.map(payload => ({ protocol, format: 'JSON', ...payload, valid: undefined }))),
  ...STRUCTURED_PAYLOADS.map(payload => ({ protocol: 3, format: 'structured', ...payload })),
];

for (const { protocol, format, label, value, valid } of cases) {
  const envelope = envelopeFor(value, undefined, protocol);
  const encoded = encodeEnvelope(envelope);
  const messages = toWire(envelope, MAX_MESSAGE);
  const received = fromWire(messages, new Reassembler(), 0);

  expect(received).toHaveLength(1);
  expect(messages.every(message => message.length <= MAX_MESSAGE)).toBe(true);
  expect(received[0].data).toEqual(value);

  if (valid) { expect(valid(received[0].data)).toBe(true); }

  describe(`v${protocol} ${format} ${label}`, () => {
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
for (const protocol of PROTOCOLS) {
  describe(`v${protocol} packing`, () => {
    const burst = stateDeltaBurst(40).map((data, i) => envelopeFor(data, `iid-1/${i}`, protocol));
    const packed = packEnvelopes(burst, MAX_MESSAGE);

    expect(fromWire(packed, new Reassembler(), 0)).toEqual(burst);

    bench('pack a 40-delta burst', () => {
      packEnvelopes(burst, MAX_MESSAGE);
    });

    bench('unpack a 40-delta burst', () => {
      fromWire(packed, new Reassembler(), 0);
    });
  });
}
