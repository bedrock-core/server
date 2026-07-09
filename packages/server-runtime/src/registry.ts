/**
 * The cross-addon registry — a live directory of every bedrock-core addon present in the
 * world, built on the sync node's discovery. Each peer's announce `meta` is interpreted as
 * an {@link AddonManifest}; the registry merges the local addon (self) with all live peers,
 * keyed by the unique namespace (e.g. `bc_economy`).
 *
 * A collision (two addons with the same namespace) is surfaced via
 * {@link Registry.onNamespaceCollision} and logged. Dependencies are matched by namespace and
 * are soft: a missing one warns but never blocks.
 */
import type { CollisionInfo, Discovery, PeerInfo, Unsubscribe } from '@bedrock-core/sync';
import { Registry as _bor } from '@bedrock-oss/add-on-registry';
import { addonTransportId, type AddonManifest, manifestFromPeer } from './manifest';

/** A manifest in the registry: its namespace as `id`, plus whether it's the local addon. */
export type RegisteredAddon = AddonManifest & { id: string; self: boolean };

export type AddonListener = (addon: RegisteredAddon) => void;
export type CollisionListener = (info: CollisionInfo) => void;

export class Registry {
  private readonly _discovery: Discovery;
  private readonly _self: RegisteredAddon;
  private readonly _onRegister = new Set<AddonListener>();
  private readonly _onUnregister = new Set<AddonListener>();
  private readonly _onCollision = new Set<CollisionListener>();
  private readonly _onDepsSatisfied = new Set<() => void>();
  private readonly _disposers: Unsubscribe[] = [];
  private _depsSatisfied: boolean;
  private _missingSinceLastCheck: string[];

  constructor(discovery: Discovery, self: AddonManifest) {
    this._discovery = discovery;
    this._self = { ...this.enrich(self), id: addonTransportId(self), self: true };
    this._missingSinceLastCheck = this.missingDependencies();
    this._depsSatisfied = this._missingSinceLastCheck.length === 0;
  }

  /** Bridge discovery events into registry events and do an initial dependency check. */
  start(): void {
    this._disposers.push(
      this._discovery.onPeerUp(peer => this.handlePeerUp(peer)),
      this._discovery.onPeerDown(peer => this.handlePeerDown(peer)),
      this._discovery.onCollision(info => this.handleCollision(info)),
    );

    const missing = this.missingDependencies();

    if (missing.length > 0) {
      console.warn(`[bedrock-core] '${this._self.id}' missing dependencies: ${missing.join(', ')}`);
    }
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }
  }

  /** Every registered addon: the local addon plus all live peers. */
  all(): RegisteredAddon[] {
    return [this._self, ...this._discovery.peers.map(peer => this.peerToAddon(peer))];
  }

  /** Look up an addon by its transport id (`creator:namespace`, e.g. `drav0011:bc_economy`). */
  get(id: string): RegisteredAddon | undefined {
    if (id === this._self.id) { return this._self; }

    const peer = this._discovery.peers.find(p => p.id === id);

    return peer ? this.peerToAddon(peer) : undefined;
  }

  /** Whether an addon with the given transport id is present. */
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** Notified when a peer addon registers (becomes visible). Returns an unsubscribe function. */
  onRegister(listener: AddonListener): Unsubscribe {
    this._onRegister.add(listener);

    return (): void => {
      this._onRegister.delete(listener);
    };
  }

  /** Notified when a peer addon unregisters (goes away). Returns an unsubscribe function. */
  onUnregister(listener: AddonListener): Unsubscribe {
    this._onUnregister.add(listener);

    return (): void => {
      this._onUnregister.delete(listener);
    };
  }

  /** Notified when another addon shares our namespace. Returns an unsubscribe function. */
  onNamespaceCollision(listener: CollisionListener): Unsubscribe {
    this._onCollision.add(listener);

    return (): void => {
      this._onCollision.delete(listener);
    };
  }

  /** This addon's declared dependencies (transport ids) that are not currently present. */
  missingDependencies(): string[] {
    const deps = this._self.dependencies ?? [];

    return deps.filter(id => !this.has(id));
  }

  /**
   * Fires when all declared dependencies are present (immediately if already satisfied, e.g.
   * none were declared). Edge-triggered on each unsatisfied→satisfied transition. Returns an
   * unsubscribe function.
   */
  onDependenciesSatisfied(listener: () => void): Unsubscribe {
    this._onDepsSatisfied.add(listener);

    if (this._depsSatisfied) { listener(); }

    return (): void => {
      this._onDepsSatisfied.delete(listener);
    };
  }

  private peerToAddon(peer: PeerInfo): RegisteredAddon {
    const manifest = this.enrich(manifestFromPeer(peer.id, peer.version, peer.meta));

    return { ...manifest, id: peer.id, self: false };
  }

  private enrich(manifest: AddonManifest): AddonManifest {
    const entry = _bor[manifest.namespace];

    if (!entry) { return manifest; }

    const patches: Partial<AddonManifest> = {};

    if (manifest.name === manifest.namespace) { patches.name = entry.name; }

    if (!manifest.creatorName) { patches.creatorName = entry.creator; }

    return Object.keys(patches).length ? { ...manifest, ...patches } : manifest;
  }

  private handlePeerUp(peer: PeerInfo): void {
    const addon = this.peerToAddon(peer);

    for (const listener of this._onRegister) { listener(addon); }

    this.evaluateDependencies();
  }

  private handlePeerDown(peer: PeerInfo): void {
    const addon = this.peerToAddon(peer);

    for (const listener of this._onUnregister) { listener(addon); }

    this.evaluateDependencies();
  }

  private handleCollision(info: CollisionInfo): void {
    console.error(`[bedrock-core] collision: another instance shares identity '${info.id}'`);

    for (const listener of this._onCollision) { listener(info); }
  }

  private evaluateDependencies(): void {
    const missing = this.missingDependencies();
    const satisfied = missing.length === 0;

    if (satisfied === this._depsSatisfied) { return; }

    this._depsSatisfied = satisfied;

    if (satisfied) {
      console.info(`[bedrock-core] '${this._self.id}' dependencies resolved: ${this._missingSinceLastCheck.join(', ')}`);

      for (const listener of this._onDepsSatisfied) { listener(); }
    } else {
      console.info(`[bedrock-core] '${this._self.id}' missing dependencies: ${missing.join(', ')}`);
    }

    this._missingSinceLastCheck = missing;
  }
}
