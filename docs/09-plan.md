# 09 — Plan

## Order

Observable first — pure, testable, and the substrate the other three notify through. Then the rename
that costs nothing. Then db, which config re-bases on. Query last among the four because it needs
db's invalidation edge and S6's number. Everything with a *Measure* tag waits for its spike.

| # | Phase | Delivers | Gate | Estimate |
| --- | --- | --- | --- | --- |
| 0 | **Plan docs** ✅ | these pages, four concerns, old → new for everything that changes | — | done |
| 1 | **`@bedrock-core/observable`** — *done* | ✅ `observable` / `computed` / `effect` / `batch`, `ReadonlyObservable`, sync scheduling, listener isolation, 28 vitest specs; ✅ `toNative` DDUI bridge as the `/minecraft` entry, releasing with `unsubscribe(cb)`; ✅ benchmarked at parity-or-better with the engine ([S7](./spikes/S7-observable-bench.md)); ✅ ui-runtime `useObservable(obs, selector?)`, source typed structurally so the UI package needs no dependency on the framework that depends on it; ✅ config nodes satisfy the observable contract — a listener’s `prev` narrowed from `value | undefined` to `value`, which no emit path could produce, pinned by a compiled type test. `ChangeEmitter` itself stays: it is a lazy path-keyed multicast that holds no values, and phase 5 rewrites the scopes over db anyway ([01-observable](./01-observable.md)) | — | done |
| 2 | **`core.shared`** — *done* | ✅ sync: owner-only apply with `open` on entries, `droppedForeign`; ✅ runtime: `register({ shared })` returns the typed tree beside the config scopes, `open()` / `persisted()` / `leaf()` markers carried in the type, `core.shared.of<Def>(ns)` from the announced `core-shared/shape`, every node `get` / `subscribe`, persistence to `core-shared:<ns>:<key>` restored a tick after registration, `core.state` deprecated; 15 specs + a type-assertion file; reference addon and GameTest on it. **Remaining**: docs-site `scoped-state.md` → `shared.md` (phase 7) ([02-shared](./02-shared.md)) | 1 | done |
| 3 | **`@bedrock-core/db`** — resolver — *package done* | ✅ `createResolver`: refusals, direct ABI, component ABI, proxied fallback; `DpHost` adapter with `prefixed`; capability record; per-type cache that never caches a throw; key scheme `core-db:<ns>:<kind>:<identity>:<collection>:<key>`, block identity carrying the type; 17 specs. **Remaining**: `persistence.ts` reduced onto it — phase 5 ([03-db §Where a document can live](./03-db.md#where-a-document-can-live--capability-not-declaration)) | — (S5 answered) | done |
| 4 | **`@bedrock-core/db`** — collections — *core done* | ✅ `db.collection` with `schema` (`version`/`defaults`/`migrate` lazy per document, quarantine under `#bad`), `accept`/`require` with the compile-time `Conflicts` check (document type named once in `schema<T>()` — TS infers all type arguments or none), acceptors composable with `anyOf`/`allOf`/`except`, validity gate re-resolving per op with proxied documents readable while unloaded, budget check + chunking on the direct ABI, identity cache, `subscribe`; ✅ chunked index + resumable `all()` that heals a replaced block; ✅ `blockCleanup(db)` custom component for `onBreak`; ✅ `coalesce` write-behind with parking on `entityLoad` and flush on `playerLeave`, lifecycle wired only when a coalescing collection exists; 45 specs + a compiled type-assertion file + `examples/elevators.ts`. **Remaining**: `shared: true \| { as }` publishing and RPC `core:db.get/patch/set` with actor auth (both ride sync); ✅ `core.db` on the runtime, the db declaration API re-exported from server-runtime; ✅ measured in the engine ([S8](./spikes/S8-db-in-game.md)) | 3 | 2 days left |
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
| S8 | **Answered 2026-09-07** — [spikes/S8](./spikes/S8-db-in-game.md): db in the engine. 1 000 block documents in 91 ms, `all()` over 1 000 in 56 ms, write-through `patch` 28 µs vs 12 raw, coalesced `patch` 6 µs, `onBreak` fires one tick later for every removal. Took four optimization rounds (index write-behind, per-tick memo, classes over closures — QuickJS). | phase 4's measured-useful bar |
| S6 | **Answered 2026-09-08** — [spikes/S6](./spikes/S6-shared-bus-cost.md): publishing is the cost, delivery is not. `state.set()` is 380 µs at 1 KB and 3 120 µs at 10 KB — 6 % of a tick for one key — and lands synchronously on the owner. Fan-out is free to the publisher (one broadcast; 2 and 4 peers cost the same). A delta converges in the **same tick** at both sizes and both fan-outs, corroborated by the existing `send_latency` figure. A 100-key boot burst applies in 1 tick, nothing dropped. So the `shared` cap is viable and the warm read holds; the limit is document size on the publishing side, which wants a coalesced publish rather than write-through. | the `shared` cap on db collections; phase 6’s warm-read claim |
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
- **No runtime code may throw out of an event subscriber.** Twelve engine types expose `isValid`, and every member of an invalidated handle throws. The engine catches what escapes a subscriber and logs it against the *pack's* name, so a library bug is reported as the consuming addon's. `isUsable()` guards every handle that outlives the moment it was obtained: one stored in a map, and anything an `afterEvents` subscriber is handed. `Entity.id` stays readable when invalid, which is what keeps id-keyed bookkeeping working.

## Harness

The GameTest runner lives in its own repository, `bedrock-core/bds-runner`, and is resolved here as
a sibling through `portal:../bds-runner` the way the ui packages are. It is private and unpublished;
the first release is 0.1.0. `bds-runner.json` at the repo root pins the engine.

`yarn test:mc` fails on an uncaught script error as well as on a failed test. An exception thrown
outside a test shares no call stack with one, so GameTest cannot fail on it and a green build over
broken code was previously possible. Errors a pack logs itself with `console.error` are not counted;
`--allow-script-errors` opts out.
