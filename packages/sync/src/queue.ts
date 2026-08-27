/**
 * Outbound queue.
 *
 * The engine processes only a bounded number of script events per tick, so we never send inline.
 * Messages are buffered and drained at most {@link MAX_FLUSH_PER_TICK} per flush tick. If a send
 * throws (e.g. an unexpectedly oversized message slipped through), the message is dropped and
 * counted rather than allowed to crash the flush loop.
 *
 * The bound is on *messages*, not bytes, which is why the queue packs rather than simply drains:
 * consecutive envelopes small enough to share a message are sent as one batch. A world with a
 * dozen nodes heartbeating spends one slot per flush instead of a dozen, and a burst of state
 * deltas costs slots proportional to its size rather than to its count.
 *
 * Packing is conditional: it produces a shape only a reader that knows the batch tag can parse, so
 * the bus switches it off for as long as a peer that predates the tag is live (see `setPacking`).
 *
 * Chunks are never packed. An envelope is only split when it fills a message on its own, so there
 * is nothing left over to pack it with, and frames of one group must stay in the queue's order.
 */
import { system } from '@minecraft/server';
import { FLUSH_INTERVAL_TICKS, MAX_FLUSH_PER_TICK, MAX_MESSAGE } from './constants';
import { batchLength, encodeBatch } from './wire';

interface Pending {

  /** `true` for a complete script-event message that must be sent alone (a chunk). */
  standalone: boolean;

  /** An encoded envelope awaiting packing, or the finished message when `standalone`. */
  text: string;
}

export interface OutboundQueueOptions {
  channel: string;
  maxFlushPerTick?: number;
  flushIntervalTicks?: number;

  /** Character budget for one script-event message; bounds how much a batch may hold. */
  maxMessage?: number;
}

export class OutboundQueue {
  private readonly _channel: string;
  private readonly _maxFlushPerTick: number;
  private readonly _flushIntervalTicks: number;
  private readonly _maxMessage: number;
  private readonly _pending: Pending[] = [];
  private _packing = true;
  private _handle: number | undefined;
  private _dropped = 0;

  constructor(options: OutboundQueueOptions) {
    this._channel = options.channel;
    this._maxFlushPerTick = options.maxFlushPerTick ?? MAX_FLUSH_PER_TICK;
    this._flushIntervalTicks = options.flushIntervalTicks ?? FLUSH_INTERVAL_TICKS;
    this._maxMessage = options.maxMessage ?? MAX_MESSAGE;
  }

  /** Entries still waiting to be sent. Packing means this is an upper bound on messages. */
  get size(): number {
    return this._pending.length;
  }

  /** Messages dropped because a send threw (inspection helper). */
  get dropped(): number {
    return this._dropped;
  }

  /**
   * Allow or forbid packing several envelopes into one message.
   *
   * A packed message is a shape only a reader that knows the batch tag can parse, so the bus turns
   * this off while any live peer is too old to read one. A lone envelope is still tagged and sent;
   * only the packing stops.
   */
  setPacking(enabled: boolean): void {
    this._packing = enabled;
  }

  /** Begin the periodic flush loop. Idempotent. */
  start(): void {
    if (this._handle !== undefined) { return; }

    this._handle = system.runInterval(() => this.flushPending(), this._flushIntervalTicks);
  }

  /** Stop flushing. Any still-pending messages are retained. */
  stop(): void {
    if (this._handle === undefined) { return; }

    system.clearRun(this._handle);
    this._handle = undefined;
  }

  /** Queue an encoded envelope. It may travel packed with its neighbours. */
  enqueueEnvelope(encoded: string): void {
    this._pending.push({ standalone: false, text: encoded });
  }

  /** Queue a finished script-event message that must be sent on its own. */
  enqueueStandalone(message: string): void {
    this._pending.push({ standalone: true, text: message });
  }

  /**
   * Take the next message off the queue, packing as many leading envelopes into it as fit.
   * Returns `undefined` once the queue is empty.
   */
  private takeNext(): string | undefined {
    const head = this._pending[0];

    if (head === undefined) { return undefined; }

    if (head.standalone) {
      this._pending.shift();

      return head.text;
    }

    const parts: string[] = [];
    const lengths: number[] = [];

    while (this._pending.length > 0) {
      const next = this._pending[0];

      if (next.standalone) { break; }

      lengths.push(next.text.length);

      // An envelope that cannot fit even alone is taken anyway: the send below will throw and
      // count it, which is a visible drop rather than a queue that never advances.
      if (batchLength(lengths) > this._maxMessage && parts.length > 0) {
        lengths.pop();
        break;
      }

      parts.push(next.text);
      this._pending.shift();

      if (!this._packing) { break; }
    }

    return encodeBatch(parts);
  }

  private flushPending(): void {
    for (let sent = 0; sent < this._maxFlushPerTick; sent++) {
      const message = this.takeNext();

      if (message === undefined) { return; }

      try {
        system.sendScriptEvent(this._channel, message);
      } catch {
        this._dropped++;
      }
    }
  }
}
