/**
 * Events — a broadcast that is delivered and forgotten.
 *
 * The third thing a bus can do, beside pushing state ({@link State}) and answering a question
 * ({@link Rpc}): the sender says something happened, every listener hears it in the same tick, and
 * nobody keeps it. A listener attached after the fact hears nothing, which is the difference from
 * state: an event is not a value, and a peer that wants the latest value wants the mirror.
 *
 * An event's namespace is the sending node's id, taken from the envelope rather than the payload,
 * so a message cannot claim to come from an addon that did not send it. That is the same owner
 * rule the mirror applies, for the same reason: robustness against a buggy pack, not security
 * against a hostile one.
 *
 * Subscribing is a filter on namespace and name, so a listener can be attached before the sender
 * is in the world — which matters here in a way it does not for state, because an event missed is
 * missed for good.
 */
import { MessageType } from './constants';
import type { Bus, Unsubscribe } from './bus';
import type { Envelope } from './envelope';

/** What travels: the event name and its payload. The namespace is the envelope's `src`. */
interface EventData {
  n: string;
  p?: unknown;
}

/** Handed the payload and the namespace that announced it. */
export type EventHandler = (payload: unknown, from: string) => void;

function isEventData(value: unknown): value is EventData {
  return typeof value === 'object' && value !== null && typeof (value as { n?: unknown }).n === 'string';
}

/** A happening: `emit` broadcasts one message, `on` listens for one sender's name, nothing is kept. */
export class Events {
  private readonly _bus: Bus;
  private readonly _selfId: string;
  private readonly _handlers = new Map<string, Set<EventHandler>>();
  private readonly _disposers: Unsubscribe[] = [];

  constructor(bus: Bus, selfId: string) {
    this._bus = bus;
    this._selfId = selfId;
  }

  start(): void {
    this._disposers.push(this._bus.on(MessageType.Event, (envelope) => { this._deliver(envelope); }));
  }

  stop(): void {
    for (const dispose of this._disposers.splice(0)) { dispose(); }

    this._handlers.clear();
  }

  /**
   * Announce that something happened, under this node's own namespace. Every realm's listeners for
   * it fire, this one's first and synchronously.
   */
  emit(name: string, payload?: unknown): void {
    this._dispatch(this._selfId, name, payload);
    this._bus.send({ type: MessageType.Event, data: { n: name, p: payload } });
  }

  /** Listen for one event of one namespace. Attaching before that addon exists is fine. */
  on(namespace: string, name: string, handler: EventHandler): Unsubscribe {
    const key = `${namespace}/${name}`;
    let set = this._handlers.get(key);

    if (set === undefined) {
      set = new Set();
      this._handlers.set(key, set);
    }

    set.add(handler);

    let released = false;

    return (): void => {
      if (released) { return; }

      released = true;
      set.delete(handler);

      if (set.size === 0) {
        this._handlers.delete(key);
      }
    };
  }

  private _deliver(envelope: Envelope): void {
    if (!isEventData(envelope.data)) { return; }

    this._dispatch(envelope.src, envelope.data.n, envelope.data.p);
  }

  /** One handler that throws must not stop the others, and must not escape into the engine. */
  private _dispatch(namespace: string, name: string, payload: unknown): void {
    const set = this._handlers.get(`${namespace}/${name}`);

    if (set === undefined) { return; }

    for (const handler of [...set]) {
      try {
        handler(payload, namespace);
      } catch (error) {
        console.warn(`[sync] a listener for '${namespace}/${name}' threw: ${String(error)}`);
      }
    }
  }
}
