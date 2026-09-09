/**
 * The message bus: the one transport every higher layer builds on.
 *
 * Responsibilities:
 *  - encode/decode {@link Envelope}s, sending one whole where it fits and splitting it into wire
 *    {@link Frame}s where it does not;
 *  - encode each message at a protocol its recipient can read (see below);
 *  - route all outbound traffic through the {@link OutboundQueue}, which rate-limits it and packs
 *    small messages together;
 *  - on receive, drop the node's own echoes (matched by instance id, not src, so a colliding
 *    twin is still heard) and anything addressed elsewhere, then dispatch by message type.
 *
 * ## Speaking each peer's protocol
 *
 * Addons update on their own schedules, so one world routinely holds nodes built against
 * different releases. The bus therefore has no single output format: `Discovery` negotiates a
 * version per peer and pushes it here with {@link Bus.setPeerProtocol}, and every send takes its
 * encoding from that table — the peer's own version for a directed message, the lowest any live
 * peer can read for a broadcast.
 *
 * Two defaults keep an unheard-of reader from being cut off. A peer not in the table has yet to
 * announce, so it gets {@link PROTOCOL_MIN}, which every supported build reads; so does a
 * broadcast sent before any peer is known. Framing too old costs a few characters. Framing too
 * new costs the whole message, for everyone behind.
 */
import { system, type ScriptEventCommandMessageAfterEvent } from '@minecraft/server';
import { Reassembler, splitIntoFrames } from './chunk';
import { BUS_CHANNEL, BUS_NAMESPACE, Cap, MAX_MESSAGE, PROTOCOL_MAX, PROTOCOL_MIN, TAGGED_WIRE_PROTOCOL } from './constants';
import { type Envelope, decodeEnvelope, encodeEnvelope } from './envelope';
import { OutboundQueue } from './queue';
import { decodeWire, encodeLegacy, tagChunk } from './wire';

/** What every `on*` / `subscribe` returns: call it to stop listening. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Unsubscribe = (...args: any[]) => void;

const EVICT_INTERVAL_TICKS = 20;

/** Handed every envelope of the type it was registered for. */
export type EnvelopeHandler = (envelope: Envelope) => void;

/** What a peer negotiated to, as pushed in by discovery. */
interface PeerProtocol {
  protocol: number;
  caps: readonly string[];
}

/** What `send()` takes beside the type and the data. */
export interface SendOptions {

  /** Target addon id; omit to broadcast. */
  dst?: string;
  type: string;

  /** Reuse a specific message id (e.g. a chunk-group); otherwise one is generated. */
  mid?: string;
  data?: unknown;

  /**
   * Force an encoding rather than taking the one negotiated for `dst`. Discovery holds announces
   * at {@link PROTOCOL_MIN} with it: the message that tells peers what we speak cannot itself
   * assume an answer.
   */
  protocol?: number;
}

/** What `new Bus()` takes beside the ids. */
export interface BusOptions {
  maxMessage?: number;

  /** Override the auto-generated instance id (mainly for tests). */
  instanceId?: string;
}

/** The transport: envelopes in and out over one script-event channel, framed, packed and rate-limited. */
export class Bus {
  private readonly _selfId: string;
  private readonly _instanceId: string;
  private readonly _maxMessage: number;
  private readonly _queue: OutboundQueue;
  private readonly _reassembler = new Reassembler();
  private readonly _handlers = new Map<string, Set<EnvelopeHandler>>();
  private readonly _peerProtocols = new Map<string, PeerProtocol>();
  private _broadcastProtocol: number = PROTOCOL_MIN;
  private _unsubscribe: Unsubscribe | undefined;
  private _evictHandle: number | undefined;
  private _counter = 0;

  constructor(selfId: string, options: BusOptions = {}) {
    this._selfId = selfId;
    this._instanceId = options.instanceId ?? `${system.currentTick.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this._maxMessage = options.maxMessage ?? MAX_MESSAGE;
    this._queue = new OutboundQueue({ channel: BUS_CHANNEL, maxMessage: this._maxMessage });
    this.recomputeBroadcast();
  }

  get selfId(): string {
    return this._selfId;
  }

  get instanceId(): string {
    return this._instanceId;
  }

  /** Pending outbound entries, before any packing (inspection helper). */
  get queueSize(): number {
    return this._queue.size;
  }

  /** The encoding a broadcast currently goes out in: the lowest any live peer can read. */
  get broadcastProtocol(): number {
    return this._broadcastProtocol;
  }

  /**
   * Record what a peer negotiated to. Discovery owns the negotiation — the announce is what
   * carries a node's supported range — and pushes the result here so the bus can address it.
   */
  setPeerProtocol(id: string, protocol: number, caps: readonly string[]): void {
    this._peerProtocols.set(id, { protocol, caps });
    this.recomputeBroadcast();
  }

  /** Drop a peer that has gone quiet, letting the world's encoding rise if it was holding it down. */
  forgetPeer(id: string): void {
    if (this._peerProtocols.delete(id)) { this.recomputeBroadcast(); }
  }

  /** Subscribe to the bus channel and start the flush + chunk-eviction loops. */
  start(): void {
    if (this._unsubscribe) { return; }

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
    const protocol = options.protocol ?? this.protocolFor(options.dst);
    const envelope: Envelope = {
      v: protocol,
      src: this._selfId,
      iid: this._instanceId,
      type: options.type,
      mid,
    };

    if (options.dst !== undefined) { envelope.dst = options.dst; }

    if (options.data !== undefined) { envelope.data = options.data; }

    // Loopback: a message addressed to our own node can never come back over the wire —
    // the receive path drops our own echoes by instance id (so a same-src twin is still
    // heard). Deliver it to local handlers directly, on the next tick to preserve the
    // async semantics of a real hop. This makes RPC-to-self work (e.g. the config UI
    // reading the config of the very addon hosting it).
    if (options.dst === this._selfId) {
      system.run(() => this.dispatch(envelope));

      return mid;
    }

    const encoded = encodeEnvelope(envelope);

    // A reader from before the wire tag takes bare frames and nothing else, so there is no
    // whole-envelope shortcut here and nothing this may be packed with.
    if (protocol < TAGGED_WIRE_PROTOCOL) {
      for (const frame of encodeLegacy(encoded, mid, this._maxMessage)) {
        this._queue.enqueueStandalone(frame);
      }

      return mid;
    }

    // The wire tag is part of the message, so both branches get one character less than the cap.
    // An envelope that fits goes whole and may be packed with its neighbours; only one that does
    // not is split, and its frames are each a message of their own.
    if (encoded.length + 1 <= this._maxMessage) {
      this._queue.enqueueEnvelope(encoded);

      return mid;
    }

    for (const frame of splitIntoFrames(encoded, mid, this._maxMessage - 1)) {
      this._queue.enqueueStandalone(tagChunk(frame));
    }

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

      if (set.size === 0) { this._handlers.delete(type); }
    };
  }

  /** The encoding to use for one destination; `undefined` means a broadcast. */
  private protocolFor(dst: string | undefined): number {
    if (dst === undefined) { return this._broadcastProtocol; }

    return this._peerProtocols.get(dst)?.protocol ?? PROTOCOL_MIN;
  }

  /**
   * Recompute what a broadcast may assume of its audience: the lowest protocol among live peers,
   * and whether every one of them can read a packed message. Both rise on their own as the peers
   * holding them down expire, so a world speeds back up once its last old addon is gone.
   */
  private recomputeBroadcast(): void {
    if (this._peerProtocols.size === 0) {
      this._broadcastProtocol = PROTOCOL_MIN;
      this._queue.setPacking(false);

      return;
    }

    let lowest = PROTOCOL_MAX;
    let packable = true;

    for (const peer of this._peerProtocols.values()) {
      if (peer.protocol < lowest) { lowest = peer.protocol; }

      if (!peer.caps.includes(Cap.Batch)) { packable = false; }
    }

    this._broadcastProtocol = lowest;
    this._queue.setPacking(packable);
  }

  private nextMid(): string {
    return `${this._instanceId}/${++this._counter}`;
  }

  private handleScriptEvent(event: ScriptEventCommandMessageAfterEvent): void {
    if (event.id !== BUS_CHANNEL) { return; }

    const wire = decodeWire(event.message);

    if (!wire) { return; }

    if (wire.kind === 'envelopes') {
      for (const envelope of wire.envelopes) { this.receive(envelope); }

      return;
    }

    const payload = this._reassembler.accept(wire.frame, system.currentTick);

    if (payload === undefined) { return; }

    const envelope = decodeEnvelope(payload);

    if (envelope) { this.receive(envelope); }
  }

  /**
   * Deliver an envelope that arrived over the wire, dropping our own echoes — matched by
   * instance id, so a same-src twin is still heard. Self-addressed messages never reach here;
   * `send` loops those back locally.
   */
  private receive(envelope: Envelope): void {
    if (envelope.iid === this._instanceId) { return; }

    this.dispatch(envelope);
  }

  /** Deliver an envelope to its type handlers, unless it is addressed to a different node. */
  private dispatch(envelope: Envelope): void {
    if (envelope.dst !== undefined && envelope.dst !== this._selfId) { return; }

    const handlers = this._handlers.get(envelope.type);

    if (!handlers) { return; }

    for (const handler of handlers) { handler(envelope); }
  }
}
