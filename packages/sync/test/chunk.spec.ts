/**
 * Framing invariants.
 *
 * `splitIntoFrames` charges each character what JSON will actually spend escaping it, which is what
 * lets a frame be filled rather than half-reserved. The risk that buys is arithmetic: get the cost
 * of one character class wrong and a frame silently overruns the engine's cap, where it is dropped
 * at send time rather than rejected here. These cases pin every class JSON widens, at the boundary
 * where an off-by-one would show.
 */
import { describe, expect, it } from 'vitest';
import { Reassembler, decodeFrame, splitIntoFrames } from '../src/chunk';
import { MAX_MESSAGE } from '../src/constants';

const CID = 'ya-a1b2c3d4/1';

// Written by code point so no reader has to unpick a source-level escape from a wire-level one.
// JSON widens both: a backslash gains a second one, a control character becomes six characters.
const BACKSLASH = String.fromCharCode(0x5c);
const CONTROL = String.fromCharCode(0x02);

/** Reassemble a group the way `Bus.handleScriptEvent` does, and return the payload. */
function reassemble(frames: readonly string[]): string | undefined {
  const reassembler = new Reassembler();
  let payload: string | undefined;

  for (const wire of frames) {
    const frame = decodeFrame(wire);

    expect(frame).toBeDefined();
    payload = reassembler.accept(frame!, 0);
  }

  return payload;
}

function expectFramesFit(frames: readonly string[], maxMessage = MAX_MESSAGE): void {
  for (const frame of frames) {
    expect(frame.length).toBeLessThanOrEqual(maxMessage);
  }
}

describe('splitIntoFrames', () => {
  it.each([
    ['plain ASCII', 'a'.repeat(20_000)],
    ['quotes, which JSON widens to two characters', '"'.repeat(20_000)],
    ['backslashes, likewise two characters', BACKSLASH.repeat(20_000)],
    ['control characters, six characters each', CONTROL.repeat(20_000)],
    ['printable non-ASCII, which JSON copies verbatim', 'é'.repeat(20_000)],
    ['a mix at no particular alignment', `{"a":"${CONTROL}é${BACKSLASH}"}`.repeat(2_000)],
  ])('fits every frame within the cap: %s', (_label, payload) => {
    const frames = splitIntoFrames(payload, CID, MAX_MESSAGE);

    expectFramesFit(frames);
    expect(reassemble(frames)).toBe(payload);
  });

  it('never splits a surrogate pair', () => {
    // One astral code point per pair, so a frame boundary landing between the halves would emit
    // two lone surrogates and corrupt the reassembled payload.
    const payload = '🧱'.repeat(10_000);
    const frames = splitIntoFrames(payload, CID, MAX_MESSAGE);

    expectFramesFit(frames);

    for (const wire of frames) {
      const part = decodeFrame(wire)!.p;

      expect(part.charCodeAt(0)).toBeLessThan(0xdc00);
      expect(part.charCodeAt(part.length - 1)).toBeGreaterThan(0xdbff);
    }

    expect(reassemble(frames)).toBe(payload);
  });

  it('fills a frame rather than reserving against escaping that did not happen', () => {
    // Real JSON escapes roughly one character in eight, so a packed frame lands near the cap.
    // The previous halved-budget split could not exceed about half of it whatever the content.
    const payload = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row-${i}` })) });
    const frames = splitIntoFrames(payload, CID, MAX_MESSAGE);

    expectFramesFit(frames);
    expect(frames.length).toBeGreaterThan(1);
    // Every frame but the last is packed; the tail carries whatever is left over.
    expect(frames[0].length).toBeGreaterThan(MAX_MESSAGE * 0.9);
  });

  it('emits one frame for an empty payload', () => {
    const frames = splitIntoFrames('', CID, MAX_MESSAGE);

    expect(frames).toHaveLength(1);
    expect(reassemble(frames)).toBe('');
  });

  it('makes progress even when the cap cannot hold one escaped character', () => {
    const frames = splitIntoFrames(CONTROL.repeat(3), CID, 1);

    expect(frames).toHaveLength(3);
    expect(reassemble(frames)).toBe(CONTROL.repeat(3));
  });
});
