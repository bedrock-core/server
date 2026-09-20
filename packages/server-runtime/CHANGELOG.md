# @bedrock-core/server-runtime

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

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - **Breaking.** Guides left the runtime: the `guide` and `guideReference` options of `register()`, `core.guides`, `core.guides.manifest`, `GuidesRegistry`, `GuideReference` and `GuideManifest` are removed. A guide is a set of compiled screens from `@bedrock-core/guides`, reached by navigating to its key, and the screens an addon publishes are read through `screens(core)` from `@bedrock-core/navigation`.

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - Everything an addon owns is declared in `register()`, and everything that crosses a realm goes over
  one of three channels.
  
  **Breaking.** `register()` installs declarations, not plain objects: `shared: registerShared(keys)`,
  `events: registerEvents(tree)`, and one field per app, such as `config: registerConfig(definition)`
  from `@bedrock-core/config`. Config and guides are no longer part of the runtime. They are the
  `@bedrock-core/config` and `@bedrock-core/guides` apps, which keep their state in a `RuntimeSlots`
  slot the runtime fills and hands back (`core.fill` / `core.slot`); `core.config`, `core.guides` and
  `core.pages` are gone.
  
  **`core.shared`** — a flat `shared` shape comes back as a typed tree, one observable per key with
  `get` / `set` / `subscribe` and the usual `(next, prev)` listener. Peers read
  `core.shared.of<Def>(ns)`, materialized from the key names the owner announces under
  `core-shared/shape`, and never write: a peer's tree has no `set`, in the type and at runtime. The
  backend subscription is attached with the first listener and released with the last. The mirror
  stores nothing — a value that must survive a restart is a db document the owner maps onto a key.
  
  **`core.events`** — an `events` shape comes back as a typed tree with `emit` and `subscribe`, the
  payload type declared by `event<T>()`. A peer reads `core.events.of<Def>(ns)`, which has
  `subscribe` alone and answers before the owning addon exists, so a listener attached early hears
  the first event announced. Nothing is replayed.
  
  **`core.rpc`** — a question the owner answers. `authorize(target, actorId, operation)` is the one
  rule such a handler applies: an operator reaches anything, anyone else only their own entity, and a
  request with no acting player is an addon acting for itself.
  
  **`core.db`** is this addon's `@bedrock-core/db`, keyed under its namespace, with the declaration
  API (`schema`, the acceptors and combinators, the errors) re-exported so a collection is declared
  from the runtime import alone. It is local: a peer reaches a document only through a method the
  owner wrote.
  
  **Every cross-addon feed is an `Announcement`** — one value under a `core-` key in the owner's
  namespace, with `provide` / `own` / `of(ns)` / `namespaces` / `subscribe` and a guard on read.
  `core.translations` is one over the bundle, its verbs at `i18n(ns)`; `core.features.flags`
  announces every flag as one record under `core-feature/flags`; the shared shape sits at
  `core.shared.shape`. `provideManifest`, `provideReference`, `referenceOf`, `bundleOf`,
  `addonsWithGuides` and `has` are gone with it.
  
  **The package exports what an addon writes against.** Registries are exported as types — the
  runtime constructs them — and the schema, document and wire helpers (`flattenSchema`,
  `defaultsOf`, `normalizeAgainst`, `coerce`, `CONFIG_COLLECTIONS`, `configMethod`,
  `SHARED_SHAPE_KEY`, `validateManifest`, `addonNamespace`, `compareVersions`, `PROTOCOL_MIN` /
  `PROTOCOL_MAX`) are no longer exported.
  
  **`core.state` and `ScopedState` are removed.** A shared key covers every call they had; the raw
  namespace, framework keys included, stays reachable at `core.node.state`.

- [#2](https://github.com/bedrock-core/server/pull/2) [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1) Thanks [@drav0011](https://github.com/drav0011)! - **Breaking.** A node writes one namespace, the one named by its id. `ownedNamespaces` and `strictOwnership` are removed from `createSync` / `SyncNode`, and `StateOptions` from the exports: every mirror only ever applied a namespace's writes from the node whose id it is, so the options could not widen that. A write to another node's namespace is dropped by every mirror and counted in `droppedForeign`, and a node answers snapshot requests for its own namespace.

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

- Updated dependencies [[`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1), [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1), [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1), [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1), [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1), [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1), [`d75b88e`](https://github.com/bedrock-core/server/commit/d75b88efe1e5f9b5594590aab85c2c557e6a37f1)]:
  - @bedrock-core/db@0.1.0
  - @bedrock-core/i18n@0.2.0
  - @bedrock-core/observable@0.1.0
  - @bedrock-core/sync@0.2.0

## 0.1.0

### Minor Changes

- [`6b7f519`](https://github.com/bedrock-core/server/commit/6b7f519dc142a305de07516c34814fb972a875cb) Thanks [@drav0011](https://github.com/drav0011)! - Config scopes are now dotted accessor trees, and `onChange` is `subscribe`.

  **Breaking.** Every config scope mirrors its schema as a tree of nodes, and every node — group or leaf — carries its own verbs, in the style of `world.afterEvents.playerSpawn.subscribe(...)`. You name the value you mean and act on it, instead of naming the scope and describing the value with a string:

  ```ts
  config.server.economy.currency.get();          // 'emerald' | 'gold' | 'diamond'
  config.server.economy.currency.set('gold');
  config.server.economy.currency.subscribe((next, prev) => { ... });
  config.server.economy.subscribe(economy => { ... });   // group level
  config.player.for(player).notifyOnLogin.get();         // entity scopes pick the entity first
  ```

  `config.server.get()` and `config.server.patch({ ... })` are unchanged — the root is just the top node of the same tree, and `patch` / `set` work at every group with the semantics they always had, scoped to that node (`config.server.economy.set({ ... })` reverts only the keys under `economy`).

  **`onChange` is renamed to `subscribe` and removed — there is no alias.** The typed dot-path form survives as the escape hatch for paths computed at runtime, now resolved relative to the node it is called on:

  ```ts
  config.server.subscribe('economy.currency', (next, prev) => { ... });
  config.server.economy.subscribe('currency', (next, prev) => { ... });
  config.player.for(player).subscribe('notifyOnLogin', (next, prev) => { ... });
  ```

  `core.state`, `core.host`, `core.guides` and `core.translations` are different APIs, and they follow — see the runtime-wide `subscribe` rename in this same release.

  **Entity scopes gained `for(entity)`**, which returns the identical tree bound to one entity, so both scopes read the same past that point. The entity-first `get(entity)` / `patch(entity, …)` / `set(entity, …)` remain for callers holding an untyped scope, such as `core.config.local`.

  The tree is **materialized once, at registration** — real objects, walked from the schema, not a `Proxy`. The schema is static and fully known when `define()` runs, so the walk happens exactly once and every later `config.server.a.b.get()` is an ordinary property lookup: the difference matters when config is read on a tick. Per-entity trees are built on first `for()` and cached until the entity leaves; a node stores nothing, resolving values through its scope on every call, so the cache cannot go stale.

  Because the verbs now live on every node, **`get`, `set`, `patch`, `subscribe` and `for` are reserved and cannot be schema keys at any depth**. A schema that uses one is rejected at registration, naming the path:

  ```text
  config schema: "server.economy.set" uses the reserved key "set"; reserved keys are get, set, patch, subscribe, for
  ```

  The list is exported as `RESERVED_KEYS` and the check as `validateConfigSchema(scope, schema)`. New types: `ServerConfigTree`, `ConfigTree`, `ConfigNode`, `ConfigChildren`, `ConfigGroupAccessor`, `ConfigLeafAccessor` and `NodeValue`, all built on the existing `SchemaToValue` / `PathValue` machinery — so a leaf's `get()` narrows exactly as the value does inside `get()` on the whole scope (enums to their literal union, `list` to `string[]`), and an unknown key is a compile error rather than an `undefined`.

- [`36322bb`](https://github.com/bedrock-core/server/commit/36322bb53d4da391170686f124b78c4144d49bf9) Thanks [@drav0011](https://github.com/drav0011)! - Named config groups, and a `multiselect` entry type.

  A schema group can now carry its own display strings:

  ```ts
  server: {
    economy: {
      $label: 'Economy',
      $description: 'Balances, currency and what players may go negative to.',
      balances: {
        startingBalance: { type: 'number', default: 100, min: 0, max: 10000, label: 'Starting Balance' },
      },
    },
  }
  ```

  They are metadata, not settings: `$label` never appears in a value object, is not patchable, and is not a dot-path. The `$` sigil keeps them out of the child namespace, so **no schema key may start with `$`** — `define()` rejects one that does. Groups without them behave exactly as before, deriving a title from the key.

  Group strings publish to a **new** replicated key, `core-config/groups`, keyed by dot-path under the same scope prefixes. `core-config/schema` is untouched, so a consumer that predates this reads it unchanged.

  New **`multiselect`** entry type — any number of a fixed `options` set, valued as `string[]` and stored as that array's JSON, exactly like a `list`. Use it wherever the option set really is fixed; a `list` stays the open-ended one.

  ```ts
  features: { type: 'multiselect', options: ['pvp', 'tp', 'shop'], default: ['pvp'], label: 'Enabled Features' },
  ```

  Internally the inference helpers (`SchemaToValue`, `DotPath`, `PathValue`, `ConfigNode`, `ConfigChildren`) now test a group with `Record<string, unknown>` rather than `Record<string, SchemaNode>`. A named group holds a `string` beside its children, and the stricter test collapsed that group — and everything beneath it — to `never`. A type-test file under `src/config/__type-tests__/` pins the shapes so it cannot regress silently.

- [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f) Thanks [@drav0011](https://github.com/drav0011)! - Initial release.

  The framework runtime on top of `@bedrock-core/sync`. An addon declares everything it needs in one `core.register()` call — there is no separate `start()`:

  ```ts
  import { core } from "@bedrock-core/server-runtime";

  const config = core.register({
    creator: "bt",
    pack: "gc_shop",
    packName: "My Cool Shop",
    version: "1.2.0",
    dependencies: ["os_bc_economy"],
    config: {
      server: {
        taxRate: {
          type: "number",
          default: 0.05,
          min: 0,
          max: 1,
          label: "Tax Rate",
        },
      },
    },
  });

  config.server.get().taxRate;
  ```

  **Identity is one Minecraft namespace**, declared as `creator` + `pack` and joined as `creator_pack` (`bt_gc_shop`). That single id is the sync transport id, the replicated-state namespace, and the namespace of every custom command and command enum the addon registers — Bedrock allows a pack exactly one of the last, and requires no two packs to share it, which is the same uniqueness the registry enforces. `core.id` reads it back.

  Included:

  - **Registry** — enumerate registered peers, react to `onRegister` and `onNamespaceCollision`.
  - **Host election** — `core.host` elects the realm running the newest runtime, so work only one realm may do (rendering the shared UI) follows the newest build rather than load order.
  - **Features** — enable and disable behaviour based on which peers are present.
  - **Config** — server / dimension / player scopes with typed accessors and live change subscriptions. Reads and writes made on a player's behalf carry an `actorId` the owning addon authorizes: server and dimension writes need an operator, and a non-operator reaches only their own player scope. Access with no actor is an addon acting for itself and stays unrestricted. Operator status is read from the readonly `playerPermissionLevel`, never the script-writable `commandPermissionLevel`. `core.config.local` exposes this addon's own scopes synchronously, for startup-time consumers such as generated config commands.
  - **Translations** — i18n bundles replicated whole (`register({ translations: bundle })`, the `@bedrock-core/generated/i18n` module): `core.translations.forPlayer(player)` returns one lazy resolver chaining every addon's published bundle (later registrations win, like Bedrock's world-level `.lang` merge), and `of(addonId)` wraps a peer's bundle in the full verb set (`t`/`key`/`raw`/`resolve`).
  - **Guides** — compiled in-game guides, declared at registration.
  - **Manifest validation** — `validateManifest` enforces the `creator` / `pack` id rules.

  `rpc` and `state` are re-exposed with your namespace pre-filled.

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

### Patch Changes

- Updated dependencies [[`f45e781`](https://github.com/bedrock-core/server/commit/f45e7812d01bf48d0a8e8bece077f2bb44de9f31), [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f)]:
  - @bedrock-core/sync@0.1.0
