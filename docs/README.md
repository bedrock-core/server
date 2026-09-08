# @bedrock-core/server — working plan

Temporary. These pages are the design the next `server-runtime` / `sync` work follows: the data
layer split into four concerns, config re-based on it, cross-addon patching, and the trust model
they all sit on. They are deleted, or moved to the docs site, once the code is the documentation.
Nothing here is user-facing.

## Status legend

| Tag | Meaning |
| --- | --- |
| **Decided** | Build to this. |
| **Proposed** | The default until a spike says otherwise. |
| **Measure** | Unverified in game. A spike comes before code depends on it. |

## Principle that decides everything below

**Nothing ships that is not measurably useful.** Every page names the cost it adds on the hot
path (per call, per tick, per write) and the spike that puts a number on it. Opt-in beats opt-out;
zero-cost-when-unused is the bar.

## The four concerns

The model is TanStack's — Store, DB, Query — with their reactive store under the name it already
has here, *observable*, plus the one thing a browser does not have and a world of isolated realms
does: a shared mirror. Each is its own package; all of them ride
`@bedrock-core/sync`, the only channel that crosses a realm.

| Concern | Package · surface | You own it | Lives in | Survives restart | Who writes |
| --- | --- | --- | --- | --- | --- |
| **Observable** | `@bedrock-core/observable` · `observable` | yes | memory | no | you |
| **Shared** | `@bedrock-core/sync` · `core.shared` | your namespace | every realm's mirror | no — map a document onto it | the owner, nobody else |
| **DB** | `@bedrock-core/db` · `core.db` | yes | your dynamic properties · local | yes | you |
| **Events** | `@bedrock-core/sync` · `core.events` | your namespace | nowhere — delivered and forgotten | no | the owner, nobody else |
| **Query** | `@bedrock-core/query` · `core.query` | **a peer** | your cache | no | the owner, via `mutate` |

Rule for surfaces: `core.X` needs the mesh; a plain import is pure.

## Reading order

| Page | One line |
| --- | --- |
| [01-observable](./01-observable.md) | The reactive primitive: `observable` / `computed` / `batch`, synchronous scheduling, the `useObservable` hook, the `toNative` DDUI bridge |
| [02-shared](./02-shared.md) | The mirror, cut to one job: a flat record of keys, one observable each, owner-only writes, no persistence, what the framework announces here |
| [03-db](./03-db.md) | Persisted documents: the capability-probing host resolver, document schema and migrations, block documents, validity, static `accept`/`require` checks |
| [04-query](./04-query.md) | A peer's data as a cache with a lifecycle: typed keys, `core.query.*` client, `useQuery` / `useMutation`, invalidation through the mirror, optimistic `mutate` |
| [05-config](./05-config.md) | Config re-based on db: schema migrations, what changes and what does not |
| [06-patching](./06-patching.md) | Cross-addon patching via `script_eval` string handlers; expression tier parked; verification before it ships |
| [07-trust-model](./07-trust-model.md) | What the framework can and cannot defend against, and what "security" means here |
| [08-data-flow](./08-data-flow.md) | Every place a value can be seen and every edge it travels, across the four concerns |
| [09-plan](./09-plan.md) | Phases, estimates, the spikes |
| [10-events](./10-events.md) | A broadcast delivered and forgotten: declared payloads, owner-only emit, listeners that may attach before the owner exists |
| [spikes/](./spikes/) | Findings pages — every measured number these pages rely on |

## Glossary

- **Realm** — one behavior pack's isolated QuickJS runtime. Only script events and scoreboards cross it.
- **Owner** — the addon that declared a collection, a shared namespace or a patch point. Its realm holds the value; everyone else reaches it through the owner.
- **Host** — where a document's bytes sit, decided by probing the target: `own` (the target holds them, they die with it) or `proxied` (a world dynamic property keyed by the target's identity).
- **Resolver** — the function that decides a host by probing the target for dynamic properties, cached per type.
- **Mirror** — a realm's local copy of `shared`. Read locally, written by deltas on the bus.
- **Warm** — a query whose cache the owner keeps filled through the mirror, so the first read needs no round trip.
- **Announcement** — a small, static, owner-written value under the reserved `core-` prefix on the mirror: a schema, a feature flag, a translation bundle.
- **Native observable** — Mojang's `ObservableNumber` / `String` / `Boolean` / `UIRawMessage`, the only thing a DDUI form redraws for. Ours binds to one per visible control through `toNative`.
