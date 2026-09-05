# 05 — Config

What config already is: a schema declared once, typed accessor trees over `server` / `dimension` /
`player`, values persisted in dynamic properties owned by the declaring addon, schema announced on
the shared mirror, values reached by peers over RPC with actor authorization. **The authoring API
does not change.** What changes underneath: config becomes a db collection with a form on top, its
persistence is db's host resolver, and peers reach it through a query.

| | Before | After |
| --- | --- | --- |
| own read/write | `config.server.taxRate.get()` / `.set()` / `.subscribe()` | unchanged |
| persistence | `persistence.ts`, three key schemes | db's host resolver ([03-db](./03-db.md#where-a-document-can-live--capability-not-declaration)) |
| change events | `ChangeEmitter` | every leaf is an `Observable` ([01-observable](./01-observable.md)); `useObservable(config.server.taxRate)` and `toNative(...)` work |
| schema announcement | `core.state` under `core-config/` | `core.shared`, same keys ([02-shared](./02-shared.md)) |
| a peer reads it | `await core.config.of(ns).server.get()` | `useQuery(peerConfig<Def>(ns).server).data`, or `core.query.observe(...)` server-side ([04-query](./04-query.md)) |
| a peer writes it | `core.config.of(ns, { actorId }).server.patch(p)` | `core.query.mutation(peerConfig(ns).server).mutate(p, { actorId })` |
| authorization | `denyReason` on the owner | unchanged, still on the owner |

## 1. Persistence — db's host resolver

Where a value lives is no longer decided per scope. The host resolver probes the target — does it
hold its own dynamic properties, by which ABI, with what budget — and caches the answer per type
([03-db](./03-db.md#where-a-document-can-live--capability-not-declaration)). `server` and
`dimension` resolve `proxied` (the world has DPs, a dimension does not); `player` resolves `own`.
The load/unload timing per scope is unchanged: `server` and `dimension` at boot (deferred one
tick), `player` on spawn and cleared on leave.

## 2. Schema migrations — *Decided*

Today a renamed key means an orphaned DP and a silent default. One mechanism, no shortcuts:
**`version` + `migrate` functions.** A creator who changes the schema bumps `version` and writes
the step that carries stored data forward — renames included.

```ts
config: {
  version: 3,
  migrate: {
    2: stored => ({ ...stored, 'pricing.taxRate': stored['tax'] ?? 0.05 }),   // 1 → 2
    3: stored => { const { legacyMode, ...rest } = stored; return rest; },      // 2 → 3
  },
  server: { … },
}
```

- `stored` is the **flat** map of raw persisted values for one target (one world for `server`, one
  entity for `player`, …). Migrations are pure `flat → flat`; the framework runs them in order from
  the stored version to `version`, then coerces against the schema as today.
- The stored version is one DP beside the values: `core-cfg:v:<addonId>` on the same location as
  the target (the world for world-keyed scopes, the entity for entity-owned). Entity targets migrate
  when they load, so a player who joins two versions late still runs every step.
- Runs inside the deferred `loadInitial` pass, **before** change events emit — subscribers only ever
  see post-migration values.
- After migration, the host's key listing gives the keys still stored that the schema no longer names.
  They are deleted — an orphan sweep, free with migration.
- **Typing.** A migration step cannot be typed against the old schema — the old schema no longer
  exists in the source. The input is honestly `Record<string, ConfigValue>` (the raw flat stored
  map) and the output the same. A creator who wants safety keeps the old flat type around and
  annotates the step themselves (`migrate: { 2: (stored: FlatV1) => … }`); the framework cannot
  conjure it. What the framework does guarantee is the *result*: after the last step, every value
  is coerced against the current schema and anything unknown is deleted — a wrong migration
  produces defaults, never corrupt state.

Versioning rules, spelled out:

- `version` is optional and defaults to `1`. An addon that never declares it behaves exactly as
  today — no migration machinery runs, zero cost. That is the compatibility statement: every
  existing addon is a version-1 addon without changing a line.
- A world (or entity) with no stored version DP is at version `1`. So when a creator later ships
  `version: 2` with a `migrate: { 2: … }` step, every existing world is correctly treated as `1`
  and runs that step on first load. Declaring `version` for the first time is itself the upgrade
  path, not a prerequisite that had to exist from day one.
- Changing only a **default** needs no migration: defaults are never persisted (only overrides
  are), so a world that never touched the setting picks up the new default automatically. A
  migration step is for stored *overrides*: renames, merges, unit changes.

Cross-addon: the published `core-config/schema` gains a `version` field. Consumers reading the
old shape see one extra key and ignore it.

## 3. Entity and block scopes — *On hold*

Both are config collections accepting those targets: `entity` resolves `own` on the entity's DPs,
`block` resolves `own` on a custom block's entity DPs (~950 bytes, [S4](./spikes/S4-block-documents.md))
and `proxied` on the world for vanilla types. Lifecycle, validity and the index are db's
([03-db](./03-db.md#block-documents--the-case-that-decides-the-shape)); config adds only the
schema, the form and operator-only authorization. RPC surface mirrors the player one.

## 4. Peers seeing a value change

Config values were pull-only; a screen showing a peer's settings could not redraw. That is now the
query's job: every config write publishes a stamp under `core-db/<ns>/config/<scope>/<target>` on
the mirror, and every peer query for it goes stale the same tick
([04-query](./04-query.md#refetch-triggers--the-minecraft-set)). No interest protocol, no polling.

## Non-goals

- A new value type. Config stays scalars, enums, lists, multiselects. Documents are db collections ([03-db](./03-db.md)).
- Auto-loading every block or entity. Lazy is the rule; a scope never scans the world.
- A `world` scope distinct from `server`. Same location, same lifetime — it is one thing.
