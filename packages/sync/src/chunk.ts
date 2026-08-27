/**
 * Framing + reassembly.
 *
 * Script-event messages are size-capped, so an encoded {@link Envelope} that exceeds the
 * budget is split across several wire frames. Every script-event message on the bus is a
 * frame — a single-frame group (`t === 1`) carries the whole envelope, larger groups are
 * reassembled by the receiver.
 */
import { CHUNK_TTL_TICKS } from './constants';

/** One wire frame. Keys are terse to spend as few of the byte budget as possible. */
export interface Frame {

  /** Chunk-group id (the sender's message id). */
  c: string;

  /** Zero-based sequence index. */
  s: number;

  /** Total frames in the group. */
  t: number;

  /** This frame's slice of the encoded envelope. */
  p: string;
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

function isFrame(value: unknown): value is Frame {
  if (typeof value !== 'object' || value === null) { return false; }

  if (!('c' in value && 's' in value && 't' in value && 'p' in value)) { return false; }

  const { c, s, t, p } = value;

  return (
    typeof c === 'string'
    && typeof s === 'number'
    && typeof t === 'number'
    && typeof p === 'string'
    && t >= 1
    && s >= 0
    && s < t
  );
}

export function decodeFrame(json: string): Frame | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  return isFrame(parsed) ? parsed : undefined;
}

/**
 * Width of one character once JSON escapes it inside a string literal. `"` and `\` gain a
 * backslash; anything below U+0020 becomes a six-character `\uXXXX`; everything else, printable
 * non-ASCII included, is copied verbatim.
 */
function escapedWidth(code: number): number {
  if (code === 0x22 || code === 0x5c) { return 2; }

  if (code < 0x20) { return 6; }

  return 1;
}

/**
 * Cut `payload` into the longest slices whose *escaped* length still fits `budget`.
 *
 * The slicing is exact rather than pessimistic: each character is charged what JSON will actually
 * spend on it, so ordinary JSON — which escapes roughly one character in eight — fills a frame
 * instead of leaving half of it reserved against an all-quotes payload that never arrives. A
 * genuinely hostile payload simply yields more slices; no slice can ever exceed the budget.
 */
function sliceToEscapedBudget(payload: string, budget: number): string[] {
  const parts: string[] = [];
  let start = 0;

  while (start < payload.length) {
    let cost = 0;
    let end = start;

    while (end < payload.length) {
      const code = payload.charCodeAt(end);
      let width = escapedWidth(code);
      let advance = 1;

      // A surrogate pair is one character to JSON. Splitting it would leave a lone high surrogate
      // at the end of one frame and a lone low surrogate at the start of the next, so the pair
      // moves as a unit or not at all.
      if (code >= 0xd800 && code <= 0xdbff && end + 1 < payload.length) {
        const low = payload.charCodeAt(end + 1);

        if (low >= 0xdc00 && low <= 0xdfff) {
          width += 1;
          advance = 2;
        }
      }

      if (cost + width > budget) { break; }

      cost += width;
      end += advance;
    }

    // Progress guard: reachable only if `maxMessage` cannot hold one escaped character, which
    // would otherwise spin forever. Such a frame overruns the cap; every real cap is far above it.
    if (end === start) { end = start + 1; }

    parts.push(payload.slice(start, end));
    start = end;
  }

  return parts.length > 0 ? parts : [''];
}

/**
 * Split an encoded envelope into frames whose individual encoded size stays within `maxMessage`.
 *
 * `s` and `t` are costed at their widest, because the frame count is not known until the split has
 * been made — reserving six digits for each is cheaper than splitting twice.
 */
export function splitIntoFrames(payload: string, cid: string, maxMessage: number): string[] {
  const overhead = encodeFrame({ c: cid, s: 999999, t: 999999, p: '' }).length;
  const parts = sliceToEscapedBudget(payload, Math.max(1, maxMessage - overhead));

  return parts.map((part, seq) => encodeFrame({ c: cid, s: seq, t: parts.length, p: part }));
}

interface PendingGroup {
  parts: (string | undefined)[];
  total: number;
  received: number;
  expiresAt: number;
}

/** Buffers multi-frame groups until complete, discarding ones that stall past their TTL. */
export class Reassembler {
  private readonly _groups = new Map<string, PendingGroup>();

  /**
   * Feed a decoded frame. Returns the fully reassembled payload once the group is complete,
   * otherwise `undefined`. `currentTick` drives TTL bookkeeping.
   */
  accept(frame: Frame, currentTick: number): string | undefined {
    // Fast path: a single-frame group is the whole payload, no buffering needed.
    if (frame.t === 1) { return frame.p; }

    let group = this._groups.get(frame.c);

    if (!group) {
      group = {
        parts: new Array<string | undefined>(frame.t),
        total: frame.t,
        received: 0,
        expiresAt: currentTick + CHUNK_TTL_TICKS,
      };
      this._groups.set(frame.c, group);
    }

    // Ignore stray frames whose total disagrees, or duplicate sequence numbers.
    if (frame.t !== group.total || frame.s >= group.total || group.parts[frame.s] !== undefined) {
      return undefined;
    }

    group.parts[frame.s] = frame.p;
    group.received++;
    group.expiresAt = currentTick + CHUNK_TTL_TICKS;

    if (group.received < group.total) { return undefined; }

    this._groups.delete(frame.c);

    return group.parts.join('');
  }

  /** Drop groups whose TTL has elapsed. Returns how many were discarded. */
  evictExpired(currentTick: number): number {
    let dropped = 0;

    for (const [cid, group] of this._groups) {
      if (group.expiresAt <= currentTick) {
        this._groups.delete(cid);
        dropped++;
      }
    }

    return dropped;
  }

  /** Number of incomplete groups currently buffered (test/inspection helper). */
  get pendingCount(): number {
    return this._groups.size;
  }
}
