/**
 * `@bedrock-core/sync` — the low-level cross-addon transport for Minecraft Bedrock.
 *
 * Each addon runs in its own isolated script realm; this package layers a message bus, peer
 * discovery, RPC and a replicated state channel on top of script events so bedrock-core
 * addons can talk to each other. sync is the first layer on `@minecraft/server` — no engine
 * abstraction, no persistence (addons persist their own data). Typical usage:
 *
 * ```ts
 * import { createSync } from '@bedrock-core/sync';
 *
 * const sync = createSync({ id: 'myaddon', version: '1.0.0' });
 * sync.start();
 *
 * sync.discovery.onPeerUp(peer => console.warn('peer up', peer.id));
 * sync.rpc.onRequest('ping', () => 'pong');
 * sync.state.set('myaddon', 'volume', 5);
 * ```
 */
export { SyncNode, createSync } from './node';
export type { SyncNodeOptions } from './node';

export { Bus } from './bus';
export type { BusOptions, EnvelopeHandler, SendOptions } from './bus';

export { Discovery } from './discovery';
export type {
  CollisionInfo,
  CollisionListener,
  DiscoveryOptions,
  PeerInfo,
  PeerListener,
} from './discovery';

export { Rpc } from './rpc';
export type { RequestHandler, RequestOptions, RpcOptions, TypedClient, RPCHandlerMap } from './rpc';

export { State, stateKey } from './state';
export type { SnapshotEntry, StateChange, StateChangeListener, StateKey, StateOptions } from './state';

export type { Unsubscribe } from './bus';
export type { Envelope } from './envelope';
export { MessageType, PROTOCOL_VERSION } from './constants';
