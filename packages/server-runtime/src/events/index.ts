export { EventsRegistry } from './events-registry';
export { registerEvents } from './declaration';
export type { EventsRegistryOptions } from './events-registry';

export { event, materialize, materializePeer } from './tree';
export type {
  EventListener,
  EventMarker,
  EventsDef,
  EventsTree,
  OwnEvent,
  PayloadOf,
  PeerEvent,
  PeerEventsTree,
} from './tree';
