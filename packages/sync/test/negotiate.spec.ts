/**
 * Negotiation invariants.
 *
 * This is the rule that decides whether two addons in one world can hear each other at all, and it
 * fails silently when wrong: no throw, no dropped-message counter, just a list with a row missing.
 * The matrix below is therefore about the edges — the version one past the window in each
 * direction, and the node that advertises no range because it predates the field.
 */
import { describe, expect, it } from 'vitest';
import { Cap, PROTOCOL_MAX, PROTOCOL_MIN } from '../src/constants';
import { capsFor, negotiateProtocol } from '../src/negotiate';

describe('negotiateProtocol', () => {
  it('settles on the newest version both sides know', () => {
    expect(negotiateProtocol(1, 2)).toBe(2);
    expect(negotiateProtocol(2, 2)).toBe(2);
  });

  it('drops to the peer’s ceiling when it is behind', () => {
    expect(negotiateProtocol(1, 1)).toBe(1);
  });

  it('reads a node that advertises no range as the oldest supported one', () => {
    expect(negotiateProtocol(undefined, undefined)).toBe(PROTOCOL_MIN);
  });

  it('caps at this build’s ceiling when the peer is ahead', () => {
    expect(negotiateProtocol(1, PROTOCOL_MAX + 5)).toBe(PROTOCOL_MAX);
  });

  it('refuses a peer that has dropped everything this build speaks', () => {
    expect(negotiateProtocol(PROTOCOL_MAX + 1, PROTOCOL_MAX + 2)).toBeUndefined();
  });

  it('refuses a peer too old for this build’s floor', () => {
    expect(negotiateProtocol(PROTOCOL_MIN - 2, PROTOCOL_MIN - 1)).toBeUndefined();
  });

  it('never returns a version outside the supported window', () => {
    for (let min = -1; min <= PROTOCOL_MAX + 2; min++) {
      for (let max = min; max <= PROTOCOL_MAX + 2; max++) {
        const agreed = negotiateProtocol(min, max);

        if (agreed === undefined) { continue; }

        expect(agreed).toBeGreaterThanOrEqual(PROTOCOL_MIN);
        expect(agreed).toBeLessThanOrEqual(PROTOCOL_MAX);
        expect(agreed).toBeLessThanOrEqual(max);
      }
    }
  });

  it('agrees with itself from both sides', () => {
    // Both nodes run this same rule over the same two ranges, which is what lets a pair settle
    // without exchanging anything: swap the arguments and the answer has to be identical.
    for (let max = PROTOCOL_MIN; max <= PROTOCOL_MAX; max++) {
      expect(negotiateProtocol(PROTOCOL_MIN, max)).toBe(Math.min(PROTOCOL_MAX, max));
    }
  });
});

describe('capsFor', () => {
  it('grants batching to a version that reads batches, even with nothing advertised', () => {
    expect(capsFor(2, undefined)).toContain(Cap.Batch);
  });

  it('withholds every capability below the tagged wire', () => {
    expect(capsFor(1, [Cap.Batch])).toEqual([]);
  });

  it('passes an advertised set through once the version allows it', () => {
    expect(capsFor(2, [])).toEqual([]);
    expect(capsFor(2, [Cap.Batch])).toEqual([Cap.Batch]);
  });
});
