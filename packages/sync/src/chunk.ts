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

export function decodeFrame(json: string): Frame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const candidate = parsed as Partial<Frame>;
  if (
    typeof candidate.c !== 'string' ||
    typeof candidate.s !== 'number' ||
    typeof candidate.t !== 'number' ||
    typeof candidate.p !== 'string' ||
    candidate.t < 1 ||
    candidate.s < 0 ||
    candidate.s >= candidate.t
  ) {
    return undefined;
  }

  return candidate as Frame;
}

/**
 * Split an encoded envelope into frames whose individual encoded size stays within
 * `maxMessage`. The part budget is halved to absorb worst-case JSON string escaping (every
 * character of `p` could become two), guaranteeing each `encodeFrame` result fits.
 */
export function splitIntoFrames(payload: string, cid: string, maxMessage: number): string[] {
  const overhead = encodeFrame({ c: cid, s: 999999, t: 999999, p: '' }).length;
  const partBudget = Math.max(1, Math.floor((maxMessage - overhead) / 2));
  const total = Math.max(1, Math.ceil(payload.length / partBudget));

  const frames: string[] = [];
  for (let seq = 0; seq < total; seq++) {
    const part = payload.slice(seq * partBudget, (seq + 1) * partBudget);
    frames.push(encodeFrame({ c: cid, s: seq, t: total, p: part }));
  }

  return frames;
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
    if (frame.t === 1) return frame.p;

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

    if (group.received < group.total) return undefined;

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
