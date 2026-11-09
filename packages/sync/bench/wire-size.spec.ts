/**
 * What a message actually costs on the bus, and the invariants that cost has to respect.
 *
 * Script events are capped in size and bounded in count per tick, so both bytes and *slots* are
 * scarce: a payload that frames badly occupies more of the send budget, and a small message sent
 * alone spends a whole slot on a mostly empty one. This spec pins the properties the wire must
 * never lose — every message fits, every group round trips — and prints the two size tables.
 */
import { describe, expect, it } from 'vitest';
import { Reassembler } from '../src/chunk';
import { MAX_FLUSH_PER_TICK, MAX_MESSAGE, PROTOCOL_MAX } from '../src/constants';
import { encodeEnvelope } from '../src/envelope';
import { PAYLOADS, type Payload, stateDeltaBurst } from './payloads';
import { envelopeFor, fromWire, packEnvelopes, PROTOCOLS, toWire, wireSize } from './pipeline';
import { STRUCTURED_PAYLOADS } from './structured';

interface Measurement {
  payload: Payload;
  messages: string[];
  envelopeChars: number;
  wireChars: number;
  protocol: number;
  format: string;
  valid?: (value: unknown) => boolean;
}

function measure(payload: Payload, protocol: number, format = 'JSON', valid?: (value: unknown) => boolean): Measurement {
  const envelope = envelopeFor(payload.value, undefined, protocol);
  const messages = toWire(envelope, MAX_MESSAGE);

  return {
    payload,
    messages,
    envelopeChars: encodeEnvelope(envelope).length,
    wireChars: wireSize(messages),
    protocol,
    format,
    valid,
  };
}

const MEASUREMENTS = [
  ...PROTOCOLS.flatMap(protocol => PAYLOADS.map(payload => measure(payload, protocol))),
  ...STRUCTURED_PAYLOADS.map(payload => measure(payload, 3, 'structured', payload.valid)),
];

describe.each(MEASUREMENTS)('v$protocol $format $payload.label', ({ payload, messages, valid }) => {
  it('keeps every message within the cap', () => {
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE);
    }
  });

  it('round trips to the original data', () => {
    const received = fromWire(messages, new Reassembler(), 0);

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(payload.value);

    if (valid) { expect(valid(received[0].data)).toBe(true); }
  });
});

describe.each(PROTOCOLS)('v%i packing', (protocol) => {
  // One node writing a page of prices in a single tick: 40 `set` calls, 40 deltas, one queue.
  const burst = stateDeltaBurst(40).map((data, i) => envelopeFor(data, `iid-1/${i}`, protocol));

  it('packs a burst of deltas into far fewer messages', () => {
    const packed = packEnvelopes(burst, MAX_MESSAGE);

    for (const message of packed) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE);
    }

    if (protocol === 1) { expect(packed.length).toBe(burst.length); } else { expect(packed.length).toBeLessThan(burst.length); }

    expect(fromWire(packed, new Reassembler(), 0)).toEqual(burst);
  });

  it('flushes a pending batch before standalone frames and preserves delivery order', () => {
    const mixed = [
      envelopeFor('first', 'mixed/1', protocol),
      envelopeFor('x'.repeat(MAX_MESSAGE * 2), 'mixed/2', protocol),
      envelopeFor('last', 'mixed/3', protocol),
    ];
    const messages = packEnvelopes(mixed, MAX_MESSAGE);

    expect(messages.every(message => message.length <= MAX_MESSAGE)).toBe(true);
    expect(fromWire(messages, new Reassembler(), 0)).toEqual(mixed);
  });

  it('prints the packing table', () => {
    const rows = [4, 12, 40].map((count) => {
      const packed = packEnvelopes(burst.slice(0, count), MAX_MESSAGE);

      return {
        protocol,
        deltas: count,
        unpackedMessages: count,
        packedMessages: packed.length,
        wireChars: wireSize(packed),
        // The engine's per-tick bound is on messages, not bytes, so this is the number that
        // decides whether a burst clears in one flush.
        slotsSaved: count - packed.length,
      };
    });

    // eslint-disable-next-line no-console
    console.table(rows);

    expect(rows).toHaveLength(3);
  });
});

describe('size report', () => {
  it('prints the table', () => {
    // eslint-disable-next-line no-console
    console.table(MEASUREMENTS.map(({ payload, protocol, format, messages, envelopeChars, wireChars }) => ({
      protocol,
      format,
      payload: payload.label,
      dataChars: format === 'JSON' ? JSON.stringify(payload.value).length : 'n/a',
      envelopeChars,
      messages: messages.length,
      wireChars,
      // What the wire adds on top of the envelope: a tag character, and for a chunked envelope the
      // per-frame header plus whatever JSON spends escaping the envelope into a frame's `p` field.
      wireOverhead: `${(wireChars / envelopeChars).toFixed(2)}x`,
      budgetUsed: `${((wireChars / (messages.length * MAX_MESSAGE)) * 100).toFixed(0)}%`,
      ticksToFlush: Math.ceil(messages.length / MAX_FLUSH_PER_TICK),
    })));

    expect(PROTOCOLS.at(-1)).toBe(PROTOCOL_MAX);
    expect(MEASUREMENTS).toHaveLength(PAYLOADS.length * PROTOCOLS.length + STRUCTURED_PAYLOADS.length);
  });
});
