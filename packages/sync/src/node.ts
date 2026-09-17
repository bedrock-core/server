/**
 * A SyncNode is one addon's handle to the cross-addon layer. It owns and wires together the
 * five subsystems — {@link Bus}, {@link Discovery}, {@link Rpc}, {@link State} and
 * {@link Events} — and drives their shared lifecycle.
 *
 * sync is the first layer on `@minecraft/server`: a node needs no engine, just an id. Several
 * nodes can live in one script realm (they talk over the real `system` script-event bus),
 * which is how in-realm GameTests exercise the whole stack.
 */
import { Bus } from './bus';
import { Discovery } from './discovery';
import { Events } from './events';
import { Rpc } from './rpc';
import { State } from './state';

/** What `new SyncNode()` and `createSync()` take. */
export interface SyncNodeOptions {

  /** Unique addon id; also the default namespace this node owns. Used as the envelope src. */
  id: string;
  version?: string;

  schemaVersion?: number;

  /** Opaque metadata broadcast with every announce; surfaced on peers as `PeerInfo.meta`. */
  meta?: Record<string, unknown>;

  /** Override the per-message size budget (mainly for tests). */
  maxMessage?: number;

  /** Override the auto-generated instance id (mainly for tests). */
  instanceId?: string;
}

/** One addon's handle to the transport: the bus, discovery, rpc, state and events, with one lifecycle. */
export class SyncNode {
  private _started = false;
  readonly id: string;
  readonly bus: Bus;
  readonly discovery: Discovery;
  readonly rpc: Rpc;
  readonly state: State;
  readonly events: Events;

  constructor(options: SyncNodeOptions) {
    this.id = options.id;
    this.bus = new Bus(options.id, { maxMessage: options.maxMessage, instanceId: options.instanceId });
    this.discovery = new Discovery(this.bus, {
      version: options.version,
      schemaVersion: options.schemaVersion,
      meta: options.meta,
    });
    this.rpc = new Rpc(this.bus);
    this.state = new State(this.bus, options.id);
    this.events = new Events(this.bus, options.id);
  }

  /** Start every subsystem. Idempotent. Order matters — see inline notes. */
  start(): void {
    if (this._started) { return; }

    this._started = true;

    // 1. Transport up first so anything that sends has a queue + subscription.
    this.bus.start();
    // 2. Responders before announcers, so an incoming whois/state-req is already answerable.
    this.rpc.start();
    this.events.start();
    this.discovery.start();
    // 3. State announces a sync request + broadcasts its owned snapshots.
    this.state.start();
  }

  stop(): void {
    if (!this._started) { return; }

    this._started = false;

    this.state.stop();
    this.discovery.stop();
    this.events.stop();
    this.rpc.stop();
    this.bus.stop();
  }
}

/** Build and return a {@link SyncNode}. Call `.start()` once your script boots. */
export function createSync(options: SyncNodeOptions): SyncNode {
  return new SyncNode(options);
}
