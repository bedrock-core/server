/**
 * `core.events` — what an addon announces to every realm, and what it listens for.
 *
 * The owner declares its events in `register({ events })` and gets the typed tree back; a peer
 * reaches another addon's with `core.events.of<Def>(ns)`, typed by the declaration that addon
 * exports. Nothing is announced and nothing is stored: an event is a name, a payload and the
 * namespace that sent it.
 *
 * `of()` never answers `undefined`. A subscription is a filter on namespace and name, so a
 * listener attached before the owning addon has registered — or before it is even installed —
 * simply hears the first event it announces. That is the difference from the mirror, where being
 * early costs nothing but being late costs nothing either.
 */
import type { Events, Unsubscribe } from '@bedrock-core/sync';
import {
  materialize,
  materializePeer,
  type EventsDef,
  type EventsTree,
  type PeerEventsTree,
} from './tree';

/** Event names beginning here are the framework's. */
export const RESERVED_EVENT_PREFIX = 'core:';

export interface EventsRegistryOptions {
  events: Events;
  namespace: string;
}

export class EventsRegistry {
  private readonly _events: Events;
  private readonly _namespace: string;
  private readonly _peers = new Map<string, unknown>();
  private _own: unknown;

  constructor(options: EventsRegistryOptions) {
    this._events = options.events;
    this._namespace = options.namespace;
  }

  /** This addon's tree, once declared. */
  get own(): EventsTree<EventsDef> | undefined {
    return this._own as EventsTree<EventsDef> | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  /** Declare this addon's events. Once per addon. */
  define<Def extends EventsDef>(def: Def): EventsTree<Def> {
    if (this._own !== undefined) {
      throw new Error('[events] already declared for this addon');
    }

    for (const name of Object.keys(def)) {
      // The framework announces on this channel too — a served endpoint's `core:changed` — so an
      // addon's own name may not start there.
      if (name.startsWith(RESERVED_EVENT_PREFIX)) {
        throw new Error(`[events] '${name}' is reserved: names beginning '${RESERVED_EVENT_PREFIX}' belong to the framework`);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const tree = materialize(this._events, this._namespace, def) as EventsTree<Def>;

    this._own = tree;

    return tree;
  }

  /**
   * Another addon's events, typed by the declaration it exports. Always a tree: listening for
   * something nobody announces is simply a listener that never fires.
   */
  of<Def extends EventsDef>(namespace: string): PeerEventsTree<Def> {
    let tree = this._peers.get(namespace);

    if (tree === undefined) {
      tree = materializePeer(this._events, namespace);
      this._peers.set(namespace, tree);
    }

    return tree as PeerEventsTree<Def>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
  }

  /**
   * Listen without a declaration: the escape hatch for a name computed at runtime, and what the
   * typed tree is built on.
   */
  on(namespace: string, name: string, listener: (payload: unknown, from: string) => void): Unsubscribe {
    return this._events.on(namespace, name, listener);
  }
}
