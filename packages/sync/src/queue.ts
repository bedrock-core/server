/**
 * Outbound queue.
 *
 * The engine processes only a bounded number of script events per tick, so we never send
 * inline. Messages are buffered and drained at most {@link MAX_FLUSH_PER_TICK} per flush
 * tick. If a send throws (e.g. an unexpectedly oversized message slipped through), the
 * message is dropped and counted rather than allowed to crash the flush loop.
 */
import { system } from '@minecraft/server';
import { FLUSH_INTERVAL_TICKS, MAX_FLUSH_PER_TICK } from './constants';

export interface OutboundQueueOptions {
  channel: string;
  maxFlushPerTick?: number;
  flushIntervalTicks?: number;
}

export class OutboundQueue {
  private readonly _channel: string;
  private readonly _maxFlushPerTick: number;
  private readonly _flushIntervalTicks: number;
  private readonly _pending: string[] = [];
  private _handle: number | undefined;
  private _dropped = 0;

  constructor(options: OutboundQueueOptions) {
    this._channel = options.channel;
    this._maxFlushPerTick = options.maxFlushPerTick ?? MAX_FLUSH_PER_TICK;
    this._flushIntervalTicks = options.flushIntervalTicks ?? FLUSH_INTERVAL_TICKS;
  }

  /** Number of messages still waiting to be sent. */
  get size(): number {
    return this._pending.length;
  }

  /** Messages dropped because a send threw (inspection helper). */
  get dropped(): number {
    return this._dropped;
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

  /** Queue a fully encoded wire message for delivery. */
  enqueue(message: string): void {
    this._pending.push(message);
  }

  private flushPending(): void {
    const count = Math.min(this._maxFlushPerTick, this._pending.length);

    for (let i = 0; i < count; i++) {
      const message = this._pending.shift();

      if (message === undefined) { break; }

      try {
        system.sendScriptEvent(this._channel, message);
      } catch {
        this._dropped++;
      }
    }
  }
}
