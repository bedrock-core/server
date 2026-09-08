# 05 — Config

Config is a schema declared once, typed accessor trees over `server` / `dimension` / `player`,
and a form the UI draws from the announced schema. Underneath it is **three db collections**,
`config-server`, `config-dimension`, `config-player`, under the declaring addon's own namespace.
The authoring API is the accessor tree; everything else is db's.

| | Config | Where it lives |
| --- | --- | --- |
| own read/write | `config.server.taxRate.get()` / `.set()` / `.subscribe()` | a node closed over a path into `collection.for(target)` |
| the document | nested exactly as the schema is, overrides only | db, wherever the target can hold bytes ([03-db](./03-db.md#where-a-document-can-live--capability-not-declaration)) |
| defaults | the schema's, at every depth | db's `defaults`, filled on read, never stored |
| coercion | min/max, enum options, list item rules | db's `normalize`, on every write — a peer's RPC included |
| change events | every node is an observable | a `computed` over the document, compared structurally |
| schema announcement | `core-config/schema` and `core-config/groups` on `core.shared` | unchanged |
| a peer reads it | `core.config.of(ns).server.get()` | `core:db.get` on `config-server`; `core.query` once phase 6 lands ([04-query](./04-query.md)) |
| a peer writes it | `core.config.of(ns, { actorId }).server.patch(p)` | `core:db.patch`, authorized by the owner's `denyReason` |

## 1. A scope is a document

```ts
const doc = collection.for(world);           // Document<{ economy: { taxRate: number; currency: string } }>

config.server === node(doc, [])              // the root's get / set / patch / subscribe are the document's
node(doc, ['economy', 'taxRate']).get()      // one field of it
```

- **Nested, not flat.** A group is an object, a leaf is its value, a list is an array. A dynamic
  property could not hold an object; a db document is JSON, so there is nothing to flatten.
- **`patch` merges deep** — db's own patch: a nested object merges key by key, an array replaces,
  `undefined` deletes a key, which is "back to default".
- **`set` on a group replaces its subtree.** A schema key the value omits is gone from the
  document and reads as its default. On the root that is `document.set`.
- **Only overrides are stored.** The schema's `normalize` drops every value equal to its default
  before the bytes are written, so an operator who never touched a setting follows a later change
  to its default. It also coerces — a number into its range, an enum onto its options, a list onto
  its item rules — and drops keys the schema does not name. A peer's write goes through the same
  pass, because it is the collection's.
- **Every node is an observable.** `subscribe` is a `computed` over the document narrowed to the
  node's slice and compared structurally: a leaf fires when its value changes, a group when
  anything under it does, never for a sibling. `useObservable(config.server.taxRate)` and
  `toNative(...)` work unchanged.
- **Before tick 1 a tree answers with the defaults.** Dynamic properties cannot be read during
  registration, so the registry opens a gate one tick later, reads every tree built so far, and db
  tells the subscribers attached in the meantime what actually loaded.

## 2. Schema migrations

`version` and `migrate` on the config definition are db's, handed to each scope's collection.

```ts
config: {
  version: 3,
  migrate: {
    2: (doc, scope) => (scope === 'server' ? { ...doc, pricing: { taxRate: doc.tax } } : doc),   // 1 → 2
    3: (doc, scope) => { const { legacyMode, ...rest } = doc; return rest; },                      // 2 → 3
  },
  server: { … },
}
```

- A step takes one target's stored document — nested, overrides only — and the scope it belongs
  to, since the same steps run for all three collections. db runs them lazily, one document at a
  time, on first read: a player who joins two versions late migrates as they load.
- `version` defaults to `1`; a document with no version is at `1`. Declaring a version for the
  first time is the upgrade path.
- Changing a default needs no migration: defaults are never stored.
- A step cannot be typed against the old schema, which no longer exists in the source. The input is
  `Record<string, unknown>`. After the last step `normalize` coerces the result against the current
  schema, so a wrong migration produces defaults, never corrupt state.

## 3. What peers see

| Collection | Announced on the mirror | Why |
| --- | --- | --- |
| `config-server` | the document, `shared: true` | one small document per addon, written when an operator changes a setting; what every peer reads |
| `config-dimension` | a version stamp | almost nobody reads a peer's dimension settings |
| `config-player` | a version stamp | a warm copy in every realm would skip the owner's read check |

Peers write only through the owner: `core:db.patch` / `core:db.set` on the scope's collection,
carrying the `actorId`, refused by `denyReason`. Never through the mirror, which only its owner
writes at all ([02-shared](./02-shared.md)). A write with no actor is an addon acting for itself
and passes ([07-trust-model](./07-trust-model.md)).

Authorization is db's one rule: an operator reaches anything; anyone else reads world and
dimension documents, and reads and writes only their own player document.

## 4. Entity and block scopes — *On hold*

Both would be config collections accepting those targets, `entity` on the entity's DPs, `block` on
a custom block's entity DPs (~950 bytes, [S4](./spikes/S4-block-documents.md)) or proxied on the
world for vanilla types. Lifecycle, validity and the index are db's; config adds the schema, the
form and operator-only authorization.

## Non-goals

- A new value type. Config stays scalars, enums, lists, multiselects. Free-form documents are db collections ([03-db](./03-db.md)).
- Auto-loading every block or entity. Lazy is the rule; a scope never scans the world.
- A `world` scope distinct from `server`. Same location, same lifetime — it is one thing.
