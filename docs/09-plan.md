# 09 — Plan

## Order

Observable first — pure, testable, and the substrate the other three notify through. Then the rename
that costs nothing. Then db, which config re-bases on. Query last among the four because it needs
db's invalidation edge and S6's number. Everything with a *Measure* tag waits for its spike.

| # | Phase | Delivers | Gate | Estimate |
| --- | --- | --- | --- | --- |
| 0 | **Plan docs** ✅ | these pages, four concerns, old → new for everything that changes | — | done |
| 1 | **`@bedrock-core/observable`** — *package done* | ✅ `observable` / `computed` / `effect` / `batch`, `ReadonlyObservable`, sync scheduling, listener isolation, 28 vitest specs; ✅ `toNative` DDUI bridge as the `/minecraft` entry, releasing with `unsubscribe(cb)`; ✅ benchmarked at parity-or-better with the engine ([S7](./spikes/S7-observable-bench.md)). **Remaining**: ui-runtime `useObservable(obs, selector)`; config's `ChangeEmitter` replaced — both in files other work has open ([01-observable](./01-observable.md)) | — | 1 day left |
| 2 | **`core.shared`** | rename with `core.state` as a deprecated alias one minor; typed accessor tree from the `shared` declaration in `register()` (reusing config's materialization), `of<Def>(ns)` built from the peer's announced shape, every node an observable with `subscribe`; `open()` / `persisted()` markers; owner-only apply filter; `persisted` through the world host; framework announcements moved under the name; docs-site `scoped-state.md` → `shared.md` ([02-shared](./02-shared.md)) | 1 | 2 days |
| 3 | **`@bedrock-core/db`** — resolver | `resolveHost(target)`: refusals, direct ABI, component ABI, proxied fallback; `DpHost` adapter; capability record; per-type cache that never caches a throw; `persistence.ts` reduced onto it, GameTests green ([03-db §Where a document can live](./03-db.md#where-a-document-can-live--capability-not-declaration)) | — (S5 answered) | 1½ days |
| 4 | **`@bedrock-core/db`** — collections | `core.db.collection` with `accept`/`require` and the static check; `version`/`defaults`/`migrate` lazy per document, quarantine; write-through, `coalesce` opt-in; validity gates; chunking; chunked index; `shared: true \| { as }` publishing stamp or value; RPC `core:db.get/patch/set` with actor auth | 3 | 4–5 days |
| 5 | **Config on db** | scopes become collections over the same targets; accessor API unchanged; `version`/`migrate` per target on load; schema still announced ([05-config](./05-config.md)) | 4 | 2 days |
| 6 | **`@bedrock-core/query`** | typed key factories `peerConfig` / `peerDoc` / `peerAll`; the client `core.query.observe / getData / fetch / invalidate / setData / mutation`; `useQuery` / `useMutation` hooks; staleTime / gcTime / maxEntries; refetch triggers; warm reads from the mirror; optimistic `mutate` with rollback and in-flight dedup; `RemoteConfigAccessor` kept as a deprecated alias one minor ([04-query](./04-query.md)) | 2, 4, S6 | 3 days |
| 7 | **Delete** | `ScopedState`, `RemoteConfigAccessor` internals, `persistence.ts`, the interest-protocol design; docs site: `scoped-state.md` gone, `config.md` cross-addon section → query, `sync/state.md` labelled transport-level, new pages for observable / shared / db / query | 6 | 1 day |
| 8 | **Patching — `script_eval` tier** | unchanged from [06-patching](./06-patching.md) | S3 + verification | 3–4 days |
| 9 | **Patching — expression tree** — *parked* | | only if 8's verification fails or a Marketplace host is needed | 1 week |
| 10 | **Trust model docs** | one page on the docs site; the "installing is trusting" sentence in get-started | — | ½ day |

Phases 1 and 2 are independent. Phase 10 can be written any time. Phase 8's build half lands in
the bundler filter repo.

## Spikes (Measure)

| # | Question | Blocks |
| --- | --- | --- |
| ~~S5~~ | **Answered 2026-09-05/06** — [spikes/S5](./spikes/S5-abi-survey.md): one direct ABI on world / entity / player / slot (six methods, batch, `Vector3`, 32 767 cap, ~10 µs set); `Dimension` and vanilla blocks have nothing; block entities throw at 1 000 chars; stackable `ItemStack` **throws** on write, non-stackable writes land on a copy; `ContainerSlot` writes cost 320 µs; `block_actor_dynamic_properties` sits on every block item. Native observables: synchronous, equal-value skipped, `subscribe` returns the callback, `unsubscribe(cb)` releases, 1 µs. An unregistered custom component in block JSON removes the block from the world. A mined block-entity item carries **no** document by default (loot function needed), and a slot holding a **stackable** item throws on write — `ContainerSlot` is a runtime-decided host. Probe deleted. | — |
| S6 | Bus cost of a shared delta: 1 KB and 10 KB values, 2 and 4 peer realms, ticks to converge, ms per apply; `persist` re-publish on boot with 100 keys. | the `shared` cap on db collections; phase 6's warm-read claim |
| S3 | `patchPoint()` per-call overhead at 0 / 1 / 5 string handlers (bar: zero-patch = plain call); registration round trip in ticks; **watchdog**: which realm an infinite-loop handler kills and whether the world recovers; scope containment with `mc` passed in; whether a `Function`-body exception carries an attributable stack. | phase 8 |
| ~~S4~~ | **Answered 2026-09-03** — [spikes/S4](./spikes/S4-block-documents.md): native block DPs work on 1.26.50 with no experiment; ~950 usable bytes, throws not truncates; `onBreak` fires for every removal incl. replace-mode `/setblock` and script `setPermutation`; pistons do not move block entities; native vs world DP cost parity; DP strings cap at 32 767 chars. | — |
| ~~S2~~ | **Answered 2026-09-03** — [spikes/S2](./spikes/S2-dynamic-property-costs.md): 17 µs per 1 KB write, 190 µs per 30 KB, 30 µs per 30 KB read; coalescing 4× only at 1 000 writes/tick; cap 32 767 chars. | — |
| ~~S0~~ | **Answered 2026-09-02** — [spikes/S-function-from-string](./spikes/S-function-from-string.md): `Function` / `eval` refused by default; with `script_eval` native speed, body scope `console,print`. | — |
| ~~S1~~ | Superseded by S4 — the block sweep it measured is replaced by native block properties plus the chunked index. | — |

Each spike is one probe in `packages/test-addon`, driven by a custom command, with its numbers
recorded in a findings page in `spikes/` whichever way they go. The probe is deleted once the page
is written.

## Decisions carried

- No central storage addon. Owners hold their data; the framework gives uniformity.
- The data layer is four concerns with four names, on one transport. `core.state` is `core.shared`; a peer's data is a query; the reactive primitive is an observable with the same `get` / `set` / `subscribe` a config leaf and a DDUI observable have; persisted documents are db.
- Own data is synchronous and authoritative; peer data is a cache with a status. Same API for both would make the fast path async by accident, so they stay different.
- `shared` is owner-only by default, `open` per key. Robustness, not security.
- Schema and migrations are part of persistence: every collection carries a `version`; db migrates one document at a time, lazily; config migrates a target on load. No UI for documents.
- db is write-through; `coalesce` is an opt-in. A DP write is 17 µs.
- Patching is real code, synchronous, in the target's realm, via `script_eval`; the expression tree is the fallback.
- No security against hostile packs. Robustness against buggy ones instead ([07-trust-model](./07-trust-model.md)).
- Nothing on the hot path for addons that do not use a feature: lazy scopes, owner-published invalidation, zero-patch dispatch measured against a plain call.
