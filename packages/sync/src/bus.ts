/**
 * The message bus: the one transport every higher layer builds on.
 *
 * Responsibilities:
 *  - encode/decode {@link Envelope}s and split/reassemble them into wire {@link Frame}s;
 *  - route all outbound traffic through the {@link OutboundQueue} (rate limiting);
 *  - on receive, drop the node's own echoes (matched by instance id, not src, so a colliding
 *    twin is still heard) and anything addressed elsewhere, then dispatch by message type.
 */
import { system, type ScriptEventCommandMessageAfterEvent } from '@minecraft/server';
import { Reassembler, decodeFrame, splitIntoFrames } from './chunk';
import { BUS_CHANNEL, BUS_NAMESPACE, MAX_MESSAGE, PROTOCOL_VERSION } from './constants';
import { type Envelope, decodeEnvelope, encodeEnvelope } from './envelope';
import { OutboundQueue } from './queue';

export type Unsubscribe = () => void;

const EVICT_INTERVAL_TICKS = 20;

export type EnvelopeHandler = (envelope: Envelope) => void;

export interface SendOptions {

  /** Target addon id; omit to broadcast. */
  dst?: string;
  type: string;

  /** Reuse a specific message id (e.g. a chunk-group); otherwise one is generated. */
  mid?: string;
  data?: unknown;
}

export interface BusOptions {
  maxMessage?: number;

  /** Override the auto-generated instance id (mainly for tests). */
  instanceId?: string;
}

export class Bus {
  private readonly _selfId: string;
  private readonly _instanceId: string;
  private readonly _maxMessage: number;
  private readonly _queue: OutboundQueue;
  private readonly _reassembler = new Reassembler();
  private readonly _handlers = new Map<string, Set<EnvelopeHandler>>();
  private _unsubscribe: Unsubscribe | undefined;
  private _evictHandle: number | undefined;
  private _counter = 0;

  constructor(selfId: string, options: BusOptions = {}) {
    this._selfId = selfId;
    this._instanceId = options.instanceId ?? `${system.currentTick.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this._maxMessage = options.maxMessage ?? MAX_MESSAGE;
    this._queue = new OutboundQueue({ channel: BUS_CHANNEL });
  }

  get selfId(): string {
    return this._selfId;
  }

  get instanceId(): string {
    return this._instanceId;
  }

  /** Pending outbound message count (inspection helper). */
  get queueSize(): number {
    return this._queue.size;
  }

  /** Subscribe to the bus channel and start the flush + chunk-eviction loops. */
  start(): void {
    if (this._unsubscribe) return;
    const handler = system.afterEvents.scriptEventReceive.subscribe(
      event => this.handleScriptEvent(event),
      { namespaces: [BUS_NAMESPACE] },
    );
    this._unsubscribe = (): void => system.afterEvents.scriptEventReceive.unsubscribe(handler);
    this._queue.start();
    this._evictHandle = system.runInterval(() => this._reassembler.evictExpired(system.currentTick), EVICT_INTERVAL_TICKS);
  }

  /** Tear down subscriptions and loops. Registered handlers are kept. */
  stop(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._queue.stop();
    if (this._evictHandle !== undefined) {
      system.clearRun(this._evictHandle);
      this._evictHandle = undefined;
    }
  }

  /** Build, frame and queue an envelope. Returns the message id. */
  send(options: SendOptions): string {
    const mid = options.mid ?? this.nextMid();
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      src: this._selfId,
      iid: this._instanceId,
      type: options.type,
      mid,
    };
    if (options.dst !== undefined) envelope.dst = options.dst;
    if (options.data !== undefined) envelope.data = options.data;

    const frames = splitIntoFrames(encodeEnvelope(envelope), mid, this._maxMessage);
    for (const frame of frames) this._queue.enqueue(frame);

    return mid;
  }

  /** Convenience: reply to a received envelope, addressing the original sender. */
  reply(to: Envelope, type: string, data?: unknown): string {
    return this.send({ dst: to.src, type, data });
  }

  /** Register a handler for a message type. Returns an unsubscribe function. */
  on(type: string, handler: EnvelopeHandler): Unsubscribe {
    let set = this._handlers.get(type);
    if (!set) {
      set = new Set();
      this._handlers.set(type, set);
    }
    set.add(handler);

    return (): void => {
      set.delete(handler);
      if (set.size === 0) this._handlers.delete(type);
    };
  }

  private nextMid(): string {
    return `${this._instanceId}/${++this._counter}`;
  }

  private handleScriptEvent(event: ScriptEventCommandMessageAfterEvent): void {
    if (event.id !== BUS_CHANNEL) return;

    const frame = decodeFrame(event.message);
    if (!frame) return;

    const payload = this._reassembler.accept(frame, system.currentTick);
    if (payload === undefined) return;

    const envelope = decodeEnvelope(payload);
    if (!envelope) return;

    // Drop our own echoes (matched by instance id, so a same-src twin is still delivered)
    // and anything addressed to a different node.
    if (envelope.iid === this._instanceId) return;
    if (envelope.dst !== undefined && envelope.dst !== this._selfId) return;

    const handlers = this._handlers.get(envelope.type);
    if (!handlers) return;
    for (const handler of handlers) handler(envelope);
  }
}
