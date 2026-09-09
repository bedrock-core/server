/**
 * The events tree: a declaration of what an addon announces, materialized into one node per name.
 *
 * A declaration says only what a payload looks like — `event<{ playerId: string }>()` — because
 * that is the entire contract. An event has no value to store, no default and no shape to
 * announce: what crosses is the name and the payload, and the type the owner exports is what makes
 * a peer's listener typed.
 *
 * The owner's nodes carry `emit` and `subscribe`; a peer's carry `subscribe` alone. A peer's tree
 * is built lazily, so a listener can be attached before the owning addon is in the world — which
 * matters for events in a way it does not for the mirror, since an event missed is missed for
 * good.
 */
import type { Events, Unsubscribe } from '@bedrock-core/sync';

declare const payloadType: unique symbol;

/**
 * One declared event, carrying its payload type and nothing else.
 *
 * The phantom property holds `T` directly rather than a function of it, so a marker for a specific
 * payload is assignable to `EventMarker<unknown>` and a declaration satisfies {@link EventsDef}.
 */
export interface EventMarker<T> {
  readonly [payloadType]?: T;
}

/** Declare an event and the shape it carries: `purchase: event<{ playerId: string }>()`. */
export function event<T = void>(): EventMarker<T> {
  return {};
}

/** A declaration: names to markers. */
export type EventsDef = Readonly<Record<string, EventMarker<unknown>>>;

/** The payload type an `event<T>()` marker carries. */
export type PayloadOf<M> = M extends EventMarker<infer T> ? T : never;

/** The listener an event takes: its payload, and the namespace that announced it. */
export type EventListener<T> = (payload: T, from: string) => void;

/** The owner's view of one event. */
export interface OwnEvent<T> {
  /** Announce it. Every realm's listeners fire, this one's first and synchronously. */
  emit(payload: T): void;
  subscribe(listener: EventListener<T>): Unsubscribe;
}

/** A peer's view of one event: listening only — an event is the owner's to announce. */
export interface PeerEvent<T> {
  subscribe(listener: EventListener<T>): Unsubscribe;
}

/** The owner's tree: one node per declared event, each with `emit` and `subscribe`. */
export type EventsTree<Def extends EventsDef> = { readonly [K in keyof Def]: OwnEvent<PayloadOf<Def[K]>> };

/** A peer's tree: the same nodes, `subscribe` alone. */
export type PeerEventsTree<Def extends EventsDef> = { readonly [K in keyof Def]: PeerEvent<PayloadOf<Def[K]>> };

// ─── Materialization ───────────────────────────────────────────────────────────

class OwnNode {
  constructor(private readonly _events: Events, private readonly _namespace: string, private readonly _name: string) {}

  emit(payload: unknown): void {
    this._events.emit(this._name, payload);
  }

  subscribe(listener: EventListener<unknown>): Unsubscribe {
    return this._events.on(this._namespace, this._name, listener);
  }
}

class PeerNode {
  constructor(private readonly _events: Events, private readonly _namespace: string, private readonly _name: string) {}

  subscribe(listener: EventListener<unknown>): Unsubscribe {
    return this._events.on(this._namespace, this._name, listener);
  }
}

/** The owner's tree: one node per declared name. */
export function materialize(events: Events, namespace: string, def: EventsDef): Record<string, unknown> {
  const tree: Record<string, unknown> = {};

  for (const name of Object.keys(def)) {
    tree[name] = new OwnNode(events, namespace, name);
  }

  return tree;
}

/**
 * A peer's tree. Nothing is announced for events, so the names are not known here — the node for
 * a name is built the first time it is asked for and kept from then on. A `Proxy`, like the typed
 * rpc client: touched when a listener is attached, never on a tick.
 */
export function materializePeer(events: Events, namespace: string): Record<string, unknown> {
  const nodes = new Map<string, PeerNode>();

  return new Proxy({}, {
    get: (_target, property): unknown => {
      if (typeof property !== 'string') { return undefined; }

      let node = nodes.get(property);

      if (node === undefined) {
        node = new PeerNode(events, namespace, property);
        nodes.set(property, node);
      }

      return node;
    },
  });
}
