# @bedrock-core/sync

## 0.2.0

### Minor Changes

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - Who is present is a value, not a stream: discovery, the registry and the host election are
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

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - **Breaking.** A node writes one namespace, the one named by its id. `ownedNamespaces` and `strictOwnership` are removed from `createSync` / `SyncNode`, and `StateOptions` from the exports: every mirror only ever applied a namespace's writes from the node whose id it is, so the options could not widen that. A write to another node's namespace is dropped by every mirror and counted in `droppedForeign`, and a node answers snapshot requests for its own namespace.

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - **Owner-only state.** A mirror applies an entry for a namespace only from the namespace's owner —
  the sending node for a delta, the recorded writer for a snapshot entry, so a snapshot relayed by a
  third party still names the original writer. Anything else is dropped and counted in
  `droppedForeign`. The rule holds for a node's own writes too, so a foreign write is visible locally
  exactly when it is visible everywhere, which is never.
  
  **`Events`, the subsystem for a happening.** `node.events.emit(name, payload)` broadcasts one
  message; `on(namespace, name, handler)` subscribes to one sender's name. The namespace a handler
  matches is the envelope's `src`, read from the transport rather than the payload, so a message
  cannot claim to come from a node that did not send it. The sender dispatches to its own handlers
  first, synchronously, before the message leaves; a handler that throws is caught and the others
  still run. Nothing is stored and nothing is replayed.

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - Rework the script-event wire format, and negotiate the protocol per peer instead of demanding a
  match.
  
  A message now opens with a tag saying which shape follows: one envelope, a batch of envelopes, or
  one frame of a chunked envelope. An envelope that fits in a message is sent whole instead of nested
  inside a frame's `p` field, so it is no longer JSON-escaped to sit inside a JSON string — a small
  message loses about a third of its length, and a round trip costs roughly half the CPU.
  
  The outbound queue packs consecutive envelopes into one message up to the size cap. The engine
  bounds script events per tick by count rather than by size, so a node that sends a burst in a single
  tick — a run of `State.set` calls, a snapshot broadcast, an RPC fan-out — now spends a few of its
  per-tick slots instead of one per envelope. Each addon has its own queue, so this packs one node's
  own traffic and never several nodes' together.
  
  Framing charges each character what JSON actually spends escaping it, rather than reserving two
  characters for every one. Real payloads fill a frame instead of half of it: a 16KB envelope splits
  into 10 frames where it previously took 18.
  
  **`PROTOCOL_VERSION` is replaced by `PROTOCOL_MIN` and `PROTOCOL_MAX`.** A node advertises the
  range it speaks in every announce and talks to each peer at the newest version both know, so a
  world may hold addons built against different releases without partitioning. Gating on one exact
  version would have made this bump — and every later one — a silent split: two meshes on a single
  channel, each listing only its own half, each electing its own UI host, each timing out every RPC
  to the other.
  
  Consequently:
  
  - A protocol-1 message is a bare frame with no tag, and is read as one. Announces and `whois` are
    pinned to `PROTOCOL_MIN` so the message that establishes a version never assumes one.
  - Broadcasts go out at the lowest version any live peer can read, and packing stops while a peer
    that predates the batch tag is present. Both recover on their own once that peer expires.
  - `PeerInfo` gains `protocol` and `caps`. Capabilities are advertised per node and narrowed by the
    negotiated version, so a later addition can appear or degrade without a version bump.
  - A node whose range does not overlap this build's is reported through
    `Discovery.onIncompatible` / `Registry.onIncompatible` and listed by `Registry.incompatible()`,
    with a warning naming both ranges. It is named rather than silently absent.
  - `negotiateProtocol` and `capsFor` are exported for anyone writing an interoperating
    implementation.
  
  The support window is two versions wide. Raising `PROTOCOL_MIN` drops everything below it and is a
  breaking change.
  
  `MAX_MESSAGE`, the default per-message character budget, is now exported alongside the existing
  `BusOptions.maxMessage` override.

### Patch Changes

- Updated dependencies [[`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1)]:
  - @bedrock-core/observable@0.1.0

## 0.1.0

### Minor Changes

- [`f45e781`](https://github.com/bedrock-core/server/commit/f45e7812d01bf48d0a8e8bece077f2bb44de9f31) Thanks [@drav0011](https://github.com/drav0011)! - Every listener registration in the framework is `subscribe`. `onChange` is gone, with no alias.

  **Breaking.** Config scopes were renamed to `subscribe` in this same release, to match `world.afterEvents.playerSpawn.subscribe(...)` — and then the rest of the stack still said `onChange`, so an addon subscribing to two things wrote the verb two ways for no reason a reader could name. One idiom now, top to bottom:

  ```ts
  core.state.subscribe(({ key, value, deleted }) => {
    /* … */
  }); // ScopedState
  core.host.subscribe((hostId, previousHostId) => {
    /* … */
  }); // HostElection
  core.translations.subscribe(() => {
    /* … */
  }); // TranslationsRegistry
  core.guides.subscribe(() => {
    /* … */
  }); // GuidesRegistry
  core.node.state.subscribe(({ ns, key }) => {
    /* … */
  }); // sync's State, unscoped
  ```

  `sync`'s `State.onChange` moved with them, since the four runtime registrations above are what delegate to it — leaving the bottom of the stack on the old name would have made the persistence pattern in every README read against itself. Nothing else changed: the listener signatures, the filtering `ScopedState` does, the coarse payload-free `TranslationsRegistry` / `GuidesRegistry` notifications, and the `Unsubscribe` return are all as they were, so migrating is renaming the call.

  `Registry` is deliberately untouched. `onRegister`, `onUnregister`, `onNamespaceCollision` and `onDependenciesSatisfied` have the same listener-in / unsubscribe-out shape, but they are four _distinct_ events rather than one "something changed" channel — they cannot all be `subscribe`, and picking one to rename would be worse than leaving the set alone.

- [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f) Thanks [@drav0011](https://github.com/drav0011)! - Initial release.

  The low-level cross-addon transport. Every addon runs in its own isolated script realm; `sync` layers four things on top of script events so they can reach each other:

  - **Bus** — the script-event message bus, with envelopes and chunked sends.
  - **Discovery** — peers announce identity and version, and report namespace collisions.
  - **Rpc** — typed request/response between addons, with timeouts and a typed client.
  - **State** — replicated last-write-wins key/value, scoped to your namespace.

  ```ts
  import { createSync } from "@bedrock-core/sync";

  const sync = createSync({ id: "myaddon", version: "1.0.0" });
  sync.start();

  sync.discovery.onPeerUp((peer) => console.warn("peer up", peer.id));
  sync.rpc.onRequest("ping", () => "pong");
  sync.state.set("myaddon", "volume", 5);
  ```

  No engine abstraction and no persistence — addons persist their own data.
