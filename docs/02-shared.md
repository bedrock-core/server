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
const shared = core.register({
  // …identity…
  shared: {
    spawnRate: 5,
    highScore: open(0),                                   // anyone may write this one
    event: persisted({ name: 'none', active: false }),    // this branch survives restart
  },
});

shared.spawnRate.set(6);                                  // writes, broadcasts
shared.event.active.subscribe(on => …);                   // a leaf
shared.event.subscribe(event => …);                       // a branch — fires when any child changes
shared.subscribe(all => …);                               // the whole namespace

const shop = core.shared.of<ShopShared>('os_shop');       // a peer's tree — read-only, or undefined until it announces
shop?.stock.get();
shop?.stock.subscribe(n => …);
shop?.sale.subscribe(sale => …);                          // any branch, any leaf
```

Exactly the accessor tree config already has: materialized once from the declared shape, every
node — root, branch, leaf — carrying `get` / `subscribe`, leaves and own branches also `set` /
`patch`. No accessor functions, no string keys, autocomplete to the leaf.

- **Own tree** comes back from `register()` (and as `core.shared` afterwards), built from the
  `shared` object: its values are the initial values, its nesting the keys. Nested paths flatten to
  dotted mirror keys (`event.active`), the same way config flattens.
- **A peer's tree** is `core.shared.of<Def>(ns)`. The peer announces its shape (key paths, no
  values — a few dozen bytes under `core-shared/shape`) when it registers, so the tree is
  materialized from that and `Def` is the compile-time view over it — the same arrangement as
  `core.config.of<Def>(ns)` and its published schema. `undefined` until the peer is in the world.
- **Every node is an observable** ([01-observable](./01-observable.md)): `useObservable(shop.stock)`,
  `computed(…, [shared.event.active])`, `toNative(shared.spawnRate)` — no glue. A peer's nodes are
  `ReadonlyObservable` at the type level, the rule the mirror enforces at runtime.
- **`open()` and `persisted()` mark a leaf or a whole branch** in the declaration; both are inherited
  downward. Nothing else on this page changes.

The `core-` prefix stays reserved for the framework, and the raw namespace — framework keys
included — stays reachable at `core.node.state`.

## Who may write — *Decided*

Today any node may write any namespace and mirrors apply whatever arrives. That is right at the
transport layer and wrong one layer up: a persisted value two realms disagree about ends with a
Lamport clock deciding what the disk believes.

- **Default: owner-only.** A mirror applies a delta for namespace `ns` only when the delta's
  `src === ns`. Anything else is dropped with one debug log line. Sync deltas already carry `src`,
  so this is a filter in the apply path, not a protocol change.
- **`open()` per leaf or branch.** The owner marks it writable by anyone in the declaration; the
  flag travels in the owner's own entry and mirrors honor non-owner deltas for those keys. For the
  shared counter, the lobby vote, the thing that genuinely has many writers. LWW as today.
- This is robustness against a *buggy* peer, not security: a hostile pack can forge `src`
  ([07-trust-model](./07-trust-model.md)). The filter makes the common mistake impossible, no more.

Wire impact: one optional field on the entry. Stays inside the current `PROTOCOL_MIN..MAX` window
— an old node ignores the field and keeps LWW-on-everything for what it applies locally.

## `persist` — *Decided*

`persisted()` on a leaf or branch writes its value through db's world host on every change
(`core-shared:<ns>:<key>`) and re-publishes on boot, before discovery, so a late-joining peer's
first snapshot already has it. This closes the sync README's standing "persistence is each addon's
own responsibility" for the values that live here. The owner persists; a peer's mirror never does.

Budget is the DP's: 32 767 characters, throws past it ([S2](./spikes/S2-dynamic-property-costs.md)).
A persisted shared value is a small value by construction.

## What the framework keeps here

Every current framework use is an *announcement* — small, static, owner-written, read by all —
and stays exactly where it is, under the reserved prefix:

| Key space | Written by | Read by |
| --- | --- | --- |
| `core-config/schema`, `core-config/groups` | config, on register | any UI building a form |
| `core-i18n/…`, `core-guide/…` | translations, guides | any realm resolving strings / drawing pages |
| `core-feature/…` | features | any condition depending on a peer's feature |
| host election | runtime | every runtime |
| `core-db/<ns>/<collection>/<key>` — **new** | db, for collections marked `shared` | query caches in every realm ([04-query](./04-query.md)) |

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
