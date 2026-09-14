---
"@bedrock-core/sync": minor
"@bedrock-core/server-runtime": minor
---

Who is present is a value, not a stream: discovery, the registry and the host election are
observables.

**Breaking.** `discovery.peers` and `discovery.incompatiblePeers` are `ReadonlyObservable` lists
rather than array getters, so they read `.get()`, watch with `.subscribe()`, and compose with
`computed()` like a config leaf or a shared value:

```ts
sync.discovery.peers.subscribe(peers => redraw(peers));
core.registry.addons.subscribe(addons => redraw(addons));

const hostBanner = computed(() => `hosted by ${core.host.id.get()}`, [core.host.id]);
```

The lists republish only when the world actually changes. A heartbeat that repeats what a peer
already said refreshes its liveness and notifies nobody, which is what lets a listener sit on the
list without waking every five seconds per peer. `lastSeen` therefore left `PeerInfo` and
`IncompatiblePeer` — a tick that moves on every heartbeat cannot live inside an observable value —
and is asked for by id instead:

```ts
sync.discovery.lastSeen('drav0011_economy');   // tick, or undefined
```

`onPeerUp` / `onPeerDown` / `onRegister` / `onUnregister` stay: an arrival is a delta, and a
caller that wants the one peer that changed still wants an event. A TTL sweep publishes the list
once for the whole sweep, before any listener runs, so a handler never sees a half-swept world.

`Registry` keeps no directory of its own — `all()`, `get()` and `has()` read `addons`, so a cached
answer can no longer disagree with the live one — and `HostElection` is `computed` over that list,
which retires its `start()`. `core.host.hostId` is now `core.host.id`, an observable; `HostListener`
takes a `previousHostId: string`, since a derived value always has one.
