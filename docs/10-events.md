# 10 — Events

`core.events` — a broadcast that is delivered and forgotten. The third thing a bus can do, beside
pushing state ([02-shared](./02-shared.md)) and answering a question (rpc): the owner says
something happened, every listener hears it in the same tick, and nobody keeps it.

## Why it is its own concern

Before this, a happening had two homes and neither fit. Announcing it on the mirror leaves a value
behind that nobody wants and that every late joiner receives as news; asking over rpc means a peer
has to know to ask, which is the polling this framework has no room for. The missing shape is the
one `world.afterEvents` already has, and every addon author already knows it.

```ts
// owner
const { events } = core.register({
  manifest,
  events: {
    purchase: event<{ playerId: string; gold: number }>(),
    levelUp:  event<{ playerId: string; level: number }>(),
  },
});

events.purchase.emit({ playerId: p.id, gold: 5 });   // one message, every realm, this tick
events.purchase.subscribe(cb);                        // the owner hears its own, synchronously
export type EconomyEvents = typeof eventsDef;

// peer
const release = core.events.of<EconomyEvents>(ECONOMY).purchase.subscribe(({ playerId, gold }, from) => {
  hud.flash(playerId, `-${gold}`);
});

release();
```

## Rules — *Decided*

- **Declared for its payload and nothing else.** `event<T>()` carries the type; there is no default,
  no initial value and no shape to announce, because what crosses is the name and the payload. The
  type the owner exports is the contract, the same arrangement `shared` and config have.
- **Owner only.** The namespace is the envelope's `src`, read from the transport rather than the
  payload, so a message cannot claim to come from an addon that did not send it. A peer's node has
  `subscribe` and no `emit`, in the type and at runtime.
- **Nothing is replayed.** Subscribe after it fired and you missed it. An event is not a value: a
  peer that wants the latest wants the mirror or an rpc answer. This is the whole difference from
  `shared`, and the reason for the next rule.
- **`of(ns)` never answers `undefined`.** A subscription is a filter on namespace and name, so a
  listener attached before the owning addon has registered — or before it is installed — simply
  hears the first event it announces. Being late is unrecoverable here, so being early has to be
  free. The peer tree is a `Proxy`, like `core.rpc.typed`: touched when a listener is attached,
  never on a tick.
- **The owner hears its own**, synchronously, before the message leaves. That is how one addon
  decouples its own modules without a second mechanism.
- **Isolation.** A listener that throws is caught, logged against the namespace and name, and the
  others still run. Nothing escapes into an engine subscriber.
- **No coalescing.** One `emit` is one message, so a per-tick counter belongs in `shared`, where
  the cost is one publish rather than one message per change.

## Wire

One message type, `event`, carrying `{ n: name, p: payload }`. The namespace is the envelope's
`src`; a malformed payload is dropped. Nothing is stored on the mirror and nothing on the world.

## What this replaces

The raw `core.node.bus.send` / `bus.on` pair, which was the only way to announce a happening and
carried no namespace filter, no types and no isolation. It stays where it is for framework
authors.

## Non-goals

- Delivery guarantees. A realm that is not listening when an event is announced has missed it, and
  the framework does not pretend otherwise.
- Ordering across senders. Per sender, messages arrive in order; between senders there is no clock
  worth trusting.
- Request and reply. That is rpc; an event has no answer.
