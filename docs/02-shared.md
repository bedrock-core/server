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
// before
core.state.set(SPAWN_RATE, 5);
core.node.state.get('os_shop', STOCK);
core.state.subscribe(change => persistMyNamespace());

// after
core.shared.set(SPAWN_RATE, 5);                        // your namespace, as before
core.shared.of('os_shop').get(STOCK);                  // any namespace, read
core.shared.subscribe(change => …);                    // your namespace, local or remote — as before
core.shared.of('os_shop').subscribe(change => …);      // a peer's namespace
core.shared.set(HIGH_SCORE, 0, { open: true });        // anyone may write this one
core.shared.set(ACTIVE_EVENT, 'harvest', { persist: true });  // survives restart

const stock = core.shared.of('os_shop').key<number>(STOCK);   // ReadonlyObservable<number | undefined>
const rate  = core.shared.key(SPAWN_RATE);                    // Observable — set() writes and broadcasts
```

The last two lines are the unification with [01-observable](./01-observable.md): **a shared key is
an observable.** `useObservable(core.shared.of(ns).key(K))` and `computed(…, [rate])` work with no
glue, and a peer's key is read-only at the type level — the same rule the mirror enforces at runtime.

`ScopedState`'s rules carry over: your namespace is pre-filled, the `core-` prefix is reserved for
the framework, `getNamespace()` returns only what you wrote.

## Who may write — *Decided*

Today any node may write any namespace and mirrors apply whatever arrives. That is right at the
transport layer and wrong one layer up: a persisted value two realms disagree about ends with a
Lamport clock deciding what the disk believes.

- **Default: owner-only.** A mirror applies a delta for namespace `ns` only when the delta's
  `src === ns`. Anything else is dropped with one debug log line. Sync deltas already carry `src`,
  so this is a filter in the apply path, not a protocol change.
- **`open: true` per key.** The owner marks a key writable by anyone; the flag travels in the
  owner's own entry and mirrors honor non-owner deltas for that key. For the shared counter, the
  lobby vote, the thing that genuinely has many writers. LWW as today.
- This is robustness against a *buggy* peer, not security: a hostile pack can forge `src`
  ([07-trust-model](./07-trust-model.md)). The filter makes the common mistake impossible, no more.

Wire impact: one optional field on the entry. Stays inside the current `PROTOCOL_MIN..MAX` window
— an old node ignores the field and keeps LWW-on-everything for what it applies locally.

## `persist` — *Decided*

`persist: true` on a key writes its value through db's world host on every change
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
