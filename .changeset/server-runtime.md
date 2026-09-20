---
"@bedrock-core/server-runtime": minor
---

Everything an addon owns is declared in `register()`, and everything that crosses a realm goes over
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
