# 02 — Shared

`core.shared` — the replicated mirror every realm holds, renamed from `core.state`. The transport
underneath is unchanged: `@bedrock-core/sync`'s `State`, a last-write-wins key/value store every
node applies deltas to. What changes is the name, who may write, and persistence.

## Why the rename

"State" named a mechanism (an in-memory mirror), and in most people's vocabulary it means either a
reactive value ([01-observable](./01-observable.md)) or a cache of someone else's data ([04-query](./04-query.md)).
The one property this thing actually has that neither of those has: **every realm reads it, and
writes are shared.** So: `shared`.

At the transport layer the name stays. `@bedrock-core/sync` is for framework authors and there a
replicated LWW key/value store is exactly what `State` is.

## Old → new

```ts
// before — string keys, one flat namespace, a change-listener firehose
core.state.set(SPAWN_RATE, 5);
core.node.state.get('os_shop', STOCK);
core.state.subscribe(change => persistMyNamespace());

// after — declare the shape once, get a typed tree; every node is an observable
export const sharedDef = {
  spawnRate: 5,
  highScore: open(0),                                   // anyone may write this one
  event: persisted({ name: 'none', active: false }),    // this branch survives restart
  palette: leaf({ fg: '#fff', bg: '#000' }),            // one object under one key, not a branch
};
export type LobbyShared = typeof sharedDef;             // peers type their view from this

const { config, shared } = core.register({ manifest, config: configDef, shared: sharedDef });

shared.spawnRate.set(6);                                  // writes, broadcasts
shared.event.active.subscribe(on => …);                   // a leaf
shared.event.subscribe(event => …);                       // a branch — fires when any child changes
shared.subscribe(all => …);                               // the whole namespace

const shop = core.shared.of<ShopShared>('os_shop');       // a peer's tree — undefined until it announces
shop?.stock.get();                                        // number | undefined: the value may lag the shape
shop?.stock.subscribe(n => …);
shop?.sale.subscribe(sale => …);                          // any branch, any leaf
shop?.votes.set(1);                                       // only where the owner said open(); a compile error elsewhere
```

`register()` hands back the typed accessors of everything declared, one key per declaration:
`const { config, shared } = core.register({ manifest, config, shared })`. Levels never mix — the
config scopes sit under `config`, the tree under `shared`. `core.state` stays one minor as a
deprecated string-keyed alias; `core.shared` is the registry (`of()`, `own`).

Exactly the accessor tree config already has: materialized once from the declared shape, every
node — root, branch, leaf — carrying `get` / `subscribe`, leaves and own branches also `set` /
`patch`. No accessor functions, no string keys, autocomplete to the leaf.

- **Own tree** comes back from `register()` (and as `core.shared.own` afterwards), built from the
  `shared` object: its values are the initial values, its nesting the keys. Nested paths flatten to
  dotted mirror keys (`event.active`). A plain object is a branch; a primitive or an array is a
  leaf; `leaf()` keeps an object as one value. `get`, `set`, `patch`, `subscribe` are reserved
  child names.
- **A peer's tree** is `core.shared.of<Def>(ns)`. The peer announces its shape (key paths, no
  values — a few dozen bytes under `core-shared/shape`) when it registers, so the tree is
  materialized from that and `Def` is the compile-time view over it — the same arrangement as
  `core.config.of<Def>(ns)` and its published schema. `undefined` until the peer is in the world.
- **Every node is an observable** ([01-observable](./01-observable.md)): `useObservable(shop.stock)`,
  `computed(…, [shared.event.active])`, `toNative(shared.spawnRate)` — no glue. A peer's nodes are
  `ReadonlyObservable` at the type level, the rule the mirror enforces at runtime.
- **`open()`, `persisted()` and `leaf()` mark a leaf or a whole branch** in the declaration; the
  first two are inherited downward and travel in the type, so a peer importing the owner's
  declaration type gets `set` exactly on the opened leaves.

The `core-` prefix stays reserved for the framework, and the raw namespace — framework keys
included — stays reachable at `core.node.state`.

## Who may write — *Decided*

Today any node may write any namespace and mirrors apply whatever arrives. That is right at the
transport layer and wrong one layer up: a persisted value two realms disagree about ends with a
Lamport clock deciding what the disk believes.

- **Default: owner-only.** A mirror applies an entry for namespace `ns` only when its `src === ns`
  — the sending node for a delta, the recorded writer for a snapshot entry, so a snapshot relayed
  by a third party still names the original writer. Anything else is dropped and counted
  (`state.droppedForeign`). Entries already carry `src`; this is a filter in the apply path, not a
  protocol change. The local mirror applies the same rule to its own writes, so a foreign write is
  visible locally exactly when it is visible everywhere.
- **`open()` per leaf or branch.** The owner marks it writable by anyone in the declaration; the
  flag travels in the owner's own entry (`open` on a delta, `o` on a snapshot entry), mirrors honor
  non-owner entries for those keys, and a non-owner entry never sets or clears the flag. For the
  shared counter, the lobby vote, the thing that genuinely has many writers. Last write wins as
  before: a higher version, then the lexicographically greater `src` on a tie.
- This is robustness against a *buggy* peer, not security: a hostile pack can forge `src`
  ([07-trust-model](./07-trust-model.md)). The filter makes the common mistake impossible, no more.

Wire impact: one optional field on the entry. Stays inside the current `PROTOCOL_MIN..MAX` window
— an old node ignores the field and keeps LWW-on-everything for what it applies locally.

## `persist` — *Decided*

`persisted()` on a leaf or branch writes its value to the world on every change
(`core-shared:<ns>:<key>`, JSON) and writes it back into the mirror one tick after registration —
dynamic properties are not readable before the first tick, so the restore is a delta that lands a
tick after the owner's first snapshot; a peer joining after that sees it in its snapshot. Until
then the owner's own tree reads the declared value. This closes the sync README's standing
"persistence is each addon's own responsibility" for the values that live here. The owner
persists; a peer's mirror never does.

Budget is the DP's: 32 767 characters, throws past it ([S2](./spikes/S2-dynamic-property-costs.md)).
A persisted shared value is a small value by construction.

## What the framework keeps here

Every current framework use is an *announcement* — small, static, owner-written, read by all —
and stays exactly where it is, under the reserved prefix:

| Key space | Written by | Read by |
| --- | --- | --- |
| `core-config/schema`, `core-config/groups` | config, on register | any UI building a form |
| `core-i18n/bundle`, `core-guide/manifest`, `core-guide/reference`, `core-addon/page` | translations, guides, pages | any realm resolving strings / drawing pages / listing addons |
| `core-feature/<id>` | features | any condition depending on a peer's feature |
| `core-shared/shape` — **new** | the shared registry, on register | `core.shared.of()` in every realm |
| `core-db/<ns>/<collection>/<key>` — **new** | db, for collections marked `shared` | query caches in every realm ([04-query](./04-query.md)) |

Host election publishes nothing: it is a pure function of the discovery registry.

The last row is the one new use: it is how a db collection keeps peers' query caches warm. Peers
never read it through `core.shared` — they read it through `core.query`, which gives them status,
staleness and a refused write.

## Measure — S6

The one number this page lacks: the cost of a delta on the bus. 1 KB and 10 KB values, 2 and 4
peer realms, ticks to converge, ms per apply. It sets the cap for what a collection may mark
`shared` and whether `persist`'s re-publish on boot needs pacing.

## Non-goals

- Reading a peer's *documents* here. That is a query; this is a mirror of small announcements.
- Structured values with a schema. A shared value is one JSON-serializable thing under one key.
- Replacing scoreboards for anything commands or JSON UI must read.
