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
import { MAX_FLUSH_PER_TICK, MAX_MESSAGE } from '../src/constants';
import { encodeEnvelope } from '../src/envelope';
import { PAYLOADS, type Payload, stateDeltaBurst } from './payloads';
import { envelopeFor, fromWire, packEnvelopes, toWire, wireSize } from './pipeline';

interface Measurement {
  payload: Payload;
  messages: string[];
  envelopeChars: number;
  wireChars: number;
}

function measure(payload: Payload): Measurement {
  const envelope = envelopeFor(payload.value);
  const messages = toWire(envelope, MAX_MESSAGE);

  return {
    payload,
    messages,
    envelopeChars: encodeEnvelope(envelope).length,
    wireChars: wireSize(messages),
  };
}

const MEASUREMENTS = PAYLOADS.map(measure);

describe.each(MEASUREMENTS)('$payload.label', ({ payload, messages }) => {
  it('keeps every message within the cap', () => {
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE);
    }
  });

  it('round trips to the original data', () => {
    const received = fromWire(messages, new Reassembler(), 0);

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual(payload.value);
  });
});

describe('packing', () => {
  // One node writing a page of prices in a single tick: 40 `set` calls, 40 deltas, one queue.
  const burst = stateDeltaBurst(40).map((data, i) => envelopeFor(data, `iid-1/${i}`));

  it('packs a burst of deltas into far fewer messages', () => {
    const packed = packEnvelopes(burst, MAX_MESSAGE);

    for (const message of packed) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE);
    }

    expect(packed.length).toBeLessThan(burst.length);
    expect(fromWire(packed, new Reassembler(), 0)).toHaveLength(burst.length);
  });

  it('prints the packing table', () => {
    const rows = [4, 12, 40].map((count) => {
      const packed = packEnvelopes(burst.slice(0, count), MAX_MESSAGE);

      return {
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
    console.table(MEASUREMENTS.map(({ payload, messages, envelopeChars, wireChars }) => ({
      payload: payload.label,
      dataChars: JSON.stringify(payload.value).length,
      envelopeChars,
      messages: messages.length,
      wireChars,
      // What the wire adds on top of the envelope: a tag character, and for a chunked envelope the
      // per-frame header plus whatever JSON spends escaping the envelope into a frame's `p` field.
      wireOverhead: `${(wireChars / envelopeChars).toFixed(2)}x`,
      budgetUsed: `${((wireChars / (messages.length * MAX_MESSAGE)) * 100).toFixed(0)}%`,
      ticksToFlush: Math.ceil(messages.length / MAX_FLUSH_PER_TICK),
    })));

    expect(MEASUREMENTS).toHaveLength(PAYLOADS.length);
  });
});
