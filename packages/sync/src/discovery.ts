/**
 * Peer discovery.
 *
 * Script events are ephemeral: a pack that loads after another has already announced never
 * hears that announce. Discovery solves this two ways — every node re-announces on a
 * heartbeat, and a freshly started node broadcasts a `whois` that prompts existing peers to
 * announce straight back. A TTL sweep drops peers that go quiet.
 *
 * Because the bus filters echoes by instance id (not src), an announce whose `src` equals our
 * own id but comes from a different instance reaches us — that's a namespace collision, which
 * we surface via {@link Discovery.onCollision} rather than storing as a peer.
 *
 * ## Negotiation
 *
 * Discovery is also where protocol versions are agreed. Every announce carries the range its
 * sender speaks, and hearing one settles the pair on the newest version both know, which is
 * pushed to the bus so traffic to that peer is encoded for it. Nothing is exchanged to arrive at
 * this: each side applies the same rule to the same advertised ranges, so both reach the same
 * answer from one message — the same reasoning the runtime's host election uses.
 *
 * A node whose range does not overlap ours at all cannot be addressed. It is surfaced through
 * {@link Discovery.onIncompatible} rather than dropped, so a world holding one can name the addon
 * that needs updating instead of showing a list quietly missing a row.
 */
import { system } from '@minecraft/server';
import { ANNOUNCE_INTERVAL_TICKS, MessageType, PEER_TTL_TICKS, PROTOCOL_MAX, PROTOCOL_MIN, SELF_CAPS } from './constants';
import { capsFor, negotiateProtocol } from './negotiate';
import type { Bus, Unsubscribe } from './bus';
import type { Envelope } from './envelope';

const PEER_SWEEP_INTERVAL_TICKS = 40;

/** Everything a node advertises about itself. */
export interface PeerInfo {
  id: string;
  version: string;
  schemaVersion: number;

  /**
   * The protocol this node and that peer settled on: the newest version both support. Traffic
   * addressed to the peer is encoded at it.
   */
  protocol: number;

  /** Optional behaviours the peer can read, narrowed to what {@link PeerInfo.protocol} allows. */
  caps: readonly string[];

  /** Opaque metadata the peer attached to its announce (e.g. a higher-layer manifest). */
  meta?: Record<string, unknown>;

  /** Tick this peer was last heard from. */
  lastSeen: number;
}

/** A detected namespace collision: another instance is announcing our own id. */
export interface CollisionInfo {
  id: string;
  instanceId: string;
}

/**
 * A node heard on the bus whose supported range does not overlap this build's, so nothing can be
 * said to it. It is reported rather than stored as a peer: a world holding one is misconfigured,
 * and the addon that cannot be talked to should be named instead of quietly missing.
 */
export interface IncompatiblePeer {
  id: string;

  /** The range the peer advertised. */
  pmin: number;
  pmax: number;

  /** Tick this node was last heard from. */
  lastSeen: number;
}

/**
 * The announce payload — the one message shape that must stay readable forever.
 *
 * Every other message can assume a negotiated protocol because the announce is what establishes
 * it; the announce itself can assume nothing, so it goes out at {@link PROTOCOL_MIN} and only ever
 * gains optional fields. A node that predates a field ignores it, which is why `pmin`/`pmax` are
 * optional here: their absence identifies a protocol-1 node exactly, since they ship with 2.
 */
interface AnnounceData {
  version: string;
  schemaVersion: number;
  meta?: Record<string, unknown>;

  /** Oldest protocol the sender still speaks. Absent on protocol-1 nodes. */
  pmin?: number;

  /** Newest protocol the sender speaks. Absent on protocol-1 nodes. */
  pmax?: number;

  /** Optional behaviours the sender can read. Absent on nodes that predate capabilities. */
  caps?: readonly string[];
}

export interface DiscoveryOptions {
  version?: string;
  schemaVersion?: number;

  /** Opaque metadata broadcast with every announce; surfaced on peers as `PeerInfo.meta`. */
  meta?: Record<string, unknown>;
  announceIntervalTicks?: number;
  peerTtlTicks?: number;
}

export type PeerListener = (peer: PeerInfo) => void;
export type CollisionListener = (info: CollisionInfo) => void;
export type IncompatibleListener = (peer: IncompatiblePeer) => void;

export class Discovery {
  private readonly _bus: Bus;
  private readonly _self: AnnounceData;
  private readonly _announceIntervalTicks: number;
  private readonly _peerTtlTicks: number;
  private readonly _peers = new Map<string, PeerInfo>();
  private readonly _incompatible = new Map<string, IncompatiblePeer>();
  private readonly _onUp = new Set<PeerListener>();
  private readonly _onDown = new Set<PeerListener>();
  private readonly _onCollision = new Set<CollisionListener>();
  private readonly _onIncompatible = new Set<IncompatibleListener>();
  private readonly _disposers: Unsubscribe[] = [];
  private readonly _handles: number[] = [];

  constructor(bus: Bus, options: DiscoveryOptions = {}) {
    this._bus = bus;
    this._self = {
      version: options.version ?? '0.0.0',
      schemaVersion: options.schemaVersion ?? 0,
      meta: options.meta,
      pmin: PROTOCOL_MIN,
      pmax: PROTOCOL_MAX,
      caps: SELF_CAPS,
    };
    this._announceIntervalTicks = options.announceIntervalTicks ?? ANNOUNCE_INTERVAL_TICKS;
    this._peerTtlTicks = options.peerTtlTicks ?? PEER_TTL_TICKS;
  }

  /** Known live peers (excludes self). */
  get peers(): PeerInfo[] {
    return Array.from(this._peers.values());
  }

  /** Live nodes whose protocol range does not overlap this build's, so they cannot be talked to. */
  get incompatiblePeers(): IncompatiblePeer[] {
    return Array.from(this._incompatible.values());
  }

  /** Wire up handlers, announce + whois immediately, then start the heartbeat/sweep loops. */
  start(): void {
    this._disposers.push(
      this._bus.on(MessageType.Announce, env => this.handleAnnounce(env)),
      this._bus.on(MessageType.Whois, env => this.handleWhois(env)),
    );

    this.announce();
    this.whois();

    this._handles.push(
      system.runInterval(() => this.announce(), this._announceIntervalTicks),
      system.runInterval(() => this.sweep(), PEER_SWEEP_INTERVAL_TICKS),
    );
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    for (const handle of this._handles.splice(0)) { system.clearRun(handle); }
  }

  /**
   * Broadcast this node's presence, including the protocol range it speaks.
   *
   * Pinned to {@link PROTOCOL_MIN} because it is the message that establishes what everything else
   * may assume: encoding it at anything newer would make it unreadable to exactly the peers it
   * exists to reach. That costs it the packing a negotiated message gets, which a heartbeat every
   * five seconds can afford.
   */
  announce(): void {
    this._bus.send({ type: MessageType.Announce, data: this._self, protocol: PROTOCOL_MIN });
  }

  /** Ask every peer to announce itself (used at startup to discover existing nodes). */
  whois(): void {
    this._bus.send({ type: MessageType.Whois, protocol: PROTOCOL_MIN });
  }

  getPeer(id: string): PeerInfo | undefined {
    return this._peers.get(id);
  }

  /** Notified when a peer is first seen. Returns an unsubscribe function. */
  onPeerUp(listener: PeerListener): Unsubscribe {
    this._onUp.add(listener);

    return (): void => {
      this._onUp.delete(listener);
    };
  }

  /** Notified when a peer expires. Returns an unsubscribe function. */
  onPeerDown(listener: PeerListener): Unsubscribe {
    this._onDown.add(listener);

    return (): void => {
      this._onDown.delete(listener);
    };
  }

  /** Notified when another instance is announcing our own id. Returns an unsubscribe function. */
  onCollision(listener: CollisionListener): Unsubscribe {
    this._onCollision.add(listener);

    return (): void => {
      this._onCollision.delete(listener);
    };
  }

  /**
   * Notified the first time a node with no overlapping protocol range is heard. Returns an
   * unsubscribe function.
   */
  onIncompatible(listener: IncompatibleListener): Unsubscribe {
    this._onIncompatible.add(listener);

    return (): void => {
      this._onIncompatible.delete(listener);
    };
  }

  private handleAnnounce(envelope: Envelope): void {
    // An announce carrying our own id (from a different instance — the bus already dropped
    // our own echoes) is a namespace collision, not a peer.
    if (envelope.src === this._bus.selfId) {
      for (const listener of this._onCollision) { listener({ id: envelope.src, instanceId: envelope.iid }); }

      return;
    }

    const data = this.parseAnnounce(envelope.data);

    if (!data) { return; }

    const protocol = negotiateProtocol(data.pmin, data.pmax);

    if (protocol === undefined) {
      this.recordIncompatible(envelope.src, data);

      return;
    }

    const existing = this._peers.get(envelope.src);
    const peer: PeerInfo = {
      id: envelope.src,
      version: data.version,
      schemaVersion: data.schemaVersion,
      protocol,
      caps: capsFor(protocol, data.caps),
      meta: data.meta,
      lastSeen: system.currentTick,
    };

    this._incompatible.delete(envelope.src);
    this._peers.set(envelope.src, peer);
    this._bus.setPeerProtocol(peer.id, peer.protocol, peer.caps);

    if (!existing) {
      for (const listener of this._onUp) { listener(peer); }
    }
  }

  private recordIncompatible(id: string, data: AnnounceData): void {
    const entry: IncompatiblePeer = {
      id,
      pmin: typeof data.pmin === 'number' ? data.pmin : PROTOCOL_MIN,
      pmax: typeof data.pmax === 'number' ? data.pmax : PROTOCOL_MIN,
      lastSeen: system.currentTick,
    };
    const first = !this._incompatible.has(id);

    this._incompatible.set(id, entry);

    if (first) {
      for (const listener of this._onIncompatible) { listener(entry); }
    }
  }

  private handleWhois(envelope: Envelope): void {
    // Reply directly to the asker so the rest of the world isn't spammed. Unlike the broadcast
    // announce this one is not pinned: it is addressed, so the bus already knows what the asker
    // reads — and before its own announce lands, an unknown destination falls back to the oldest
    // supported encoding anyway, which is exactly what a node this old needs.
    this._bus.send({ dst: envelope.src, type: MessageType.Announce, data: this._self });
  }

  private sweep(): void {
    const cutoff = system.currentTick - this._peerTtlTicks;

    for (const [id, peer] of this._peers) {
      if (peer.lastSeen < cutoff) {
        this._peers.delete(id);
        this._bus.forgetPeer(id);

        for (const listener of this._onDown) { listener(peer); }
      }
    }

    for (const [id, peer] of this._incompatible) {
      if (peer.lastSeen < cutoff) { this._incompatible.delete(id); }
    }
  }

  private parseAnnounce(data: unknown): AnnounceData | undefined {
    if (typeof data !== 'object' || data === null) { return undefined; }

    const candidate = data as Partial<AnnounceData>;

    if (typeof candidate.version !== 'string') { return undefined; }

    return {
      version: candidate.version,
      schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0,
      meta: typeof candidate.meta === 'object' && candidate.meta !== null ? candidate.meta : undefined,
      pmin: typeof candidate.pmin === 'number' ? candidate.pmin : undefined,
      pmax: typeof candidate.pmax === 'number' ? candidate.pmax : undefined,
      caps: Array.isArray(candidate.caps) ? candidate.caps.filter((c): c is string => typeof c === 'string') : undefined,
    };
  }
}
