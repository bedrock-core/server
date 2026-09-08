# 04 — Query

`core.query` — another addon's data, held in your realm as a cache with a lifecycle. TanStack
Query's model — keys, a client, hooks — cut to what a game tick can use.

**Reading side only, over the three channels that already exist.** An rpc method is the fetch and
the mutation; a `shared` key is the warm first read and, when the owner mirrors a value, the
change signal; an event is the other change signal. The owner writes nothing for query's sake
beyond what it would publish anyway, and an addon written before query ships is already queryable.
Everything below is the peer's half; the key shape and the client are the parts still to build.
Not started, and not until a screen needs it.

## The concern it names

Realm isolation makes every addon a *client* of every other addon. From your realm a peer's config
or documents are **server state**: you do not own them, they live elsewhere, they can be stale, you
read them asynchronously and change them by asking the owner. Today that surface is
`core.config.of(ns)` — a fresh RPC on every call, no cache, no dedup, no staleness, no way to be
told it changed. Query is that surface with the missing half added.

## Old → new

```ts
// before — a round trip per read, a Promise per call, nothing to subscribe to
const shop = core.config.of<ShopConfig>('os_shop');
const prices = await shop.server.get();
await core.config.of('os_shop', { actorId: player.id }).server.patch({ taxRate: 0.1 });

// after — typed keys, readable now, refetched by rules, observable
const prices = peerConfig<ShopConfig>('os_shop').server;            // QueryKey<ShopConfig['server']>
core.query.observe(prices).get().data;                              // value or undefined — this tick, always
await core.query.mutation(prices).mutate({ taxRate: 0.1 }, { actorId: player.id });

const balance = peerDoc<Balance>('os_shop', 'balances', playerId);  // a db document
const { data, status } = useQuery(balance);                          // in a screen
```

## Keys — *Decided*

A key is an array, `[namespace, collection, ...path]`, so invalidation is hierarchical exactly as in
TanStack. Nobody writes the array by hand: typed factories build it and carry the result type.

```ts
peerConfig<Def>(ns)              // .server → [ns,'config','server']   .player(id) → [ns,'config','player',id]   .dimension(id)
peerDoc<T>(ns, collection, key)  // [ns, collection, key]
peerAll<T>(ns, collection)       // [ns, collection] — the owner's index walk, paged

type QueryKey<T> = readonly string[] & { readonly [resultBrand]?: T };
```

A typo in a collection name is not a compile error on its own — the string is the peer's — but the
factory is one place to put a published `Collections` type when a peer exports one, the same way a
`ConfigDefinition` is published today.

## The client — server-side surface

```ts
core.query.observe(key)           // ReadonlyObservable<QueryResult<T>> — creates or reuses the cache entry
core.query.getData(key)           // T | undefined, no side effects
core.query.fetch(key)             // Promise<T> — force, dedups with anything in flight
core.query.invalidate(prefix)     // mark every key under the prefix stale; refetch on next observe/read
core.query.setData(key, next)     // write the cache without asking anyone (optimistic seeds, tests)
core.query.mutation(key, hooks?)  // Mutation<T>
```

```ts
interface QueryResult<T> {
  data: T | undefined;
  status: 'pending' | 'success' | 'error' | 'unavailable';
  fetchStatus: 'idle' | 'fetching';
  isStale: boolean;
  error?: string;                                     // the owner's denyReason text, verbatim
}

interface Mutation<T> extends ReadonlyObservable<MutationState> {
  mutate(patch: DeepPartial<T>, options?: { actorId?: string }): Promise<T>;
}
// hooks: onMutate(patch) → context, onError(reason, context), onSettled(result | undefined)
```

`observe(key)` returns an **observable** ([01-observable](./01-observable.md)), so `computed([q])`
and `useObservable(q)` work unchanged, and an observable-driven host binds to it like anything else.

## The hooks

```ts
const { data, status, isStale } = useQuery(balance);                 // = useObservable(core.query.observe(balance))
const { mutate, isPending, error } = useMutation(balance, { onError });
```

Sugar over the client — nothing a hook can do that `core.query.*` cannot from plain server code.

Options, per key or per namespace via `core.query.defaults(ns, options)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `staleTime` | 100 ticks (5 s) | how long `data` counts as fresh; no refetch while fresh |
| `gcTime` | 2 400 ticks (2 min) | unobserved + stale for this long → dropped from the cache |
| `maxEntries` | 256 per namespace | oldest unobserved evicted first — QuickJS realm memory is finite |

## Refetch triggers — the Minecraft set

| Trigger | Fires when |
| --- | --- |
| stale on observe/read | `staleTime` elapsed since last success — stale-while-revalidate, `data` stays available |
| **owner invalidation** | the owner writes; db publishes a version stamp (or the warm value) under `core-db/<ns>/<collection>/<key>` on the shared mirror ([02-shared](./02-shared.md)); every cache for that key goes stale the same tick |
| peer joins | registry `onRegister(ns)` — everything cached for `ns` goes stale |
| peer leaves | registry `onUnregister(ns)` — `status` becomes `unavailable`, `data` kept |
| after `mutate` | the reply *is* the new value (config RPC already answers read-after-write); no extra fetch |

Absent by design: window focus, network reconnect, polling intervals. There is no window and no
network; there is a registry that knows exactly when a peer comes and goes.

## Warm caches — how `shared` and query meet

A query definition may name a shared key as `warm`. The mirror already holds that value in every
realm, so `observe(key)` resolves `success` on first read with **no RPC**, and owner writes arrive
as mirror deltas. The consumer's code is identical either way — the owner chose to mirror the
value, the consumer never sees which path it took.

That is the whole relationship between the two: `shared` is one strategy for keeping a query's
cache warm, and it is the owner's call to make per value, never per collection.

## Mutations

`mutate` runs `onMutate`, applies the patch to the cached value immediately (optimistic), calls the
served `write` endpoint with the `actorId`, and on the reply either
replaces the cache with the authoritative value or **rolls back** to the `onMutate` snapshot and
sets `status: 'error'` with the owner's reason. In-flight requests for one key are deduplicated:
two screens asking for the same document in one tick produce one RPC.

Own data never goes through this: `core.config` and `core.db` on your own namespace are
synchronous and authoritative. Same API for own and peer would make the fast path async by
accident, so they stay different on purpose.

## What is not copied from TanStack Query

- **Suspense.** A screen is compiled and tick-driven; nothing can suspend. `data` is readable every
  tick, `undefined` plus `status` says why.
- **`unavailable` is not `error`.** A peer that is not in the world is absent, not failing. The
  registry knows; no retry loop.
- **Infinite queries, prefetching, dehydration, devtools.** Nothing here paginates, navigates or
  reloads a page; `peerAll` pages through the owner's index and that is the whole story.
- **Hand-written key arrays.** Factories only — the array is the wire format, not the API.

## Replaces

- `RemoteConfigAccessor` / `TypedRemoteConfig` / `core.config.of(ns)` — kept one minor as a
  deprecated alias over `core.query.observe(peerConfig(ns).*)`.
- The live-value-push proposal (`core:config.watch` / `core:config.changed`) — an owner that wants
  peers told emits an event or mirrors a value, and a query subscribes to whichever it named. No
  interest protocol.

## Measure

S6 ([02-shared](./02-shared.md#measure--s6)) sets what may be shared. Query itself adds one
number: cache memory at `maxEntries` × a 1 KB document, to confirm the default is sane in a
QuickJS realm.
