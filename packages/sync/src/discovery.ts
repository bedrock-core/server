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
 */
import { system } from '@minecraft/server';
import { ANNOUNCE_INTERVAL_TICKS, MessageType, PEER_TTL_TICKS } from './constants';
import type { Bus, Unsubscribe } from './bus';
import type { Envelope } from './envelope';

const PEER_SWEEP_INTERVAL_TICKS = 40;

/** Everything a node advertises about itself. */
export interface PeerInfo {
  id: string;
  version: string;
  schemaVersion: number;

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

interface AnnounceData {
  version: string;
  schemaVersion: number;
  meta?: Record<string, unknown>;
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

export class Discovery {
  private readonly _bus: Bus;
  private readonly _self: AnnounceData;
  private readonly _announceIntervalTicks: number;
  private readonly _peerTtlTicks: number;
  private readonly _peers = new Map<string, PeerInfo>();
  private readonly _onUp = new Set<PeerListener>();
  private readonly _onDown = new Set<PeerListener>();
  private readonly _onCollision = new Set<CollisionListener>();
  private readonly _disposers: Unsubscribe[] = [];
  private readonly _handles: number[] = [];

  constructor(bus: Bus, options: DiscoveryOptions = {}) {
    this._bus = bus;
    this._self = {
      version: options.version ?? '0.0.0',
      schemaVersion: options.schemaVersion ?? 0,
      meta: options.meta,
    };
    this._announceIntervalTicks = options.announceIntervalTicks ?? ANNOUNCE_INTERVAL_TICKS;
    this._peerTtlTicks = options.peerTtlTicks ?? PEER_TTL_TICKS;
  }

  /** Known live peers (excludes self). */
  get peers(): PeerInfo[] {
    return Array.from(this._peers.values());
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
    for (const dispose of this._disposers.splice(0)) dispose();
    for (const handle of this._handles.splice(0)) system.clearRun(handle);
  }

  /** Broadcast this node's presence. */
  announce(): void {
    this._bus.send({ type: MessageType.Announce, data: this._self });
  }

  /** Ask every peer to announce itself (used at startup to discover existing nodes). */
  whois(): void {
    this._bus.send({ type: MessageType.Whois });
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

  private handleAnnounce(envelope: Envelope): void {
    // An announce carrying our own id (from a different instance — the bus already dropped
    // our own echoes) is a namespace collision, not a peer.
    if (envelope.src === this._bus.selfId) {
      for (const listener of this._onCollision) listener({ id: envelope.src, instanceId: envelope.iid });

      return;
    }

    const data = this.parseAnnounce(envelope.data);
    if (!data) return;

    const existing = this._peers.get(envelope.src);
    const peer: PeerInfo = {
      id: envelope.src,
      version: data.version,
      schemaVersion: data.schemaVersion,
      meta: data.meta,
      lastSeen: system.currentTick,
    };
    this._peers.set(envelope.src, peer);

    if (!existing) {
      for (const listener of this._onUp) listener(peer);
    }
  }

  private handleWhois(envelope: Envelope): void {
    // Reply directly to the asker so the rest of the world isn't spammed.
    this._bus.send({ dst: envelope.src, type: MessageType.Announce, data: this._self });
  }

  private sweep(): void {
    const cutoff = system.currentTick - this._peerTtlTicks;
    for (const [id, peer] of this._peers) {
      if (peer.lastSeen < cutoff) {
        this._peers.delete(id);
        for (const listener of this._onDown) listener(peer);
      }
    }
  }

  private parseAnnounce(data: unknown): AnnounceData | undefined {
    if (typeof data !== 'object' || data === null) return undefined;

    const candidate = data as Partial<AnnounceData>;
    if (typeof candidate.version !== 'string') return undefined;

    return {
      version: candidate.version,
      schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0,
      meta: typeof candidate.meta === 'object' && candidate.meta !== null ? candidate.meta : undefined,
    };
  }
}
