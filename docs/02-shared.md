# 02 — Shared

`core.shared` — the replicated mirror every realm holds. The transport underneath is
`@bedrock-core/sync`'s `State`, a last-write-wins key/value store every node applies deltas to.

## The whole job

**The owner sets a value, every realm can read it now, and is told when it changes.** That
sentence is the feature. Anything past it belongs to another concern: persistence is a db document
([03-db](./03-db.md)), a happening is an event, and a value only some peers want is an rpc answer.

```ts
export const sharedDef = {
  currency: 'gold',
  event: { name: 'none', active: false },   // one object under one key, written whole
};
export type EconomyShared = typeof sharedDef;   // peers type their view from this

const { config, shared } = core.register({ manifest, config: configDef, shared: sharedDef });

shared.currency.set('emerald');                 // writes, broadcasts, lands this tick
shared.event.subscribe((next, prev) => …);      // an observable, like every config leaf

const economy = core.shared.of<EconomyShared>('drav0011_economy');   // undefined until it announces
economy?.currency.get();                        // string | undefined: the value may lag the shape
economy?.event.subscribe(event => …);
```

`register()` hands back the typed accessors of everything declared, one key per declaration.

## Flat, one value per key — *Decided*

A declaration is a flat record. Every top-level key is one value; an object is one value too,
replicated whole on every write.

- **No branches, no dotted paths, no `patch`.** A shape that wants structure puts an object in one
  key and pays for it on each write, which is the honest cost: publishing serializes on the
  owner's tick, 380 µs per KB ([S6](./spikes/S6-shared-bus-cost.md)). Nesting hid that behind a
  per-leaf write and bought nothing the caller could not do with one object.
- **Every node is an observable** ([01-observable](./01-observable.md)): `get` / `subscribe` with
  the usual `(next, prev)` listener, plus `set` on the owner's own tree. `useObservable(economy.currency)`,
  `computed(…, [shared.event])` and `toNative(shared.currency)` take one as it is. The backend
  subscription is attached with the first listener and released with the last, so a tree nobody
  watches costs nothing per change.
- **A peer's tree** is `core.shared.of<Def>(ns)`, materialized from the key names the owner
  announces under `core-shared/shape`. `undefined` until the owner is in the world; a key the
  mirror has not received yet reads `undefined`.
- **The owner's tree falls back to the declared value** while the mirror has none, so it answers
  correctly before its first write lands. A peer has no such fallback: it never knows what the
  owner declared.
- An addon's own key may not begin `core-`, the framework's announcement prefix.

## Who may write — *Decided*

**Only the owner.** A mirror applies an entry for namespace `ns` only when its `src === ns` — the
sending node for a delta, the recorded writer for a snapshot entry, so a snapshot relayed by a
third party still names the original writer. Anything else is dropped and counted
(`state.droppedForeign`). The local mirror applies the same rule to its own writes, so a foreign
write is visible locally exactly when it is visible everywhere, which is never.

A peer's tree has no `set` at all, in the type and at runtime. A peer that wants a change asks the
owner over rpc, where the owner applies its own rules and can refuse.

There is no per-key opt-out. Two authorities over one replicated value is the failure this rule
exists to prevent, and an addon that wants many writers wants an rpc method. This is robustness
against a *buggy* peer, not security: a hostile pack can forge `src`
([07-trust-model](./07-trust-model.md)). The filter makes the common mistake impossible, no more.

## Not storage — *Decided*

The mirror never touches the world. A shared value that must survive a restart lives in a db
document, and the owner maps it across in one line:

```ts
const settings = core.db.collection('settings', {
  schema: schema<{ event: Event }>({ defaults: { event: { name: 'none', active: false } } }),
  accept: worldTarget(),
});

settings.for(world).subscribe(doc => { if (doc !== undefined) { shared.event.set(doc.event); } });
```

A document's subscriber hears the document load, so that line is correct at boot as well as on
every later change — and the document, not the mirror, is where migrations, quarantine and the
budget check already live. Persistence in two places was one mechanism too many.

## What the framework keeps here

Every framework use is an *announcement* — small, static, owner-written, read by all — under the
reserved prefix:

| Key space | Written by | Read by |
| --- | --- | --- |
| `core-config/schema`, `core-config/groups` | config, on register | any UI building a form |
| `core-i18n/bundle`, `core-guide/manifest`, `core-guide/reference`, `core-addon/page` | translations, guides, pages | any realm resolving strings / drawing pages / listing addons |
| `core-feature/<id>` | features | any condition depending on a peer's feature |
| `core-shared/shape` | the shared registry, on register | `core.shared.of()` in every realm |

Host election publishes nothing: it is a pure function of the discovery registry. The raw
namespace, framework keys included, stays reachable at `core.node.state`.

## Measured — S6

[S6](./spikes/S6-shared-bus-cost.md): publishing is the cost, delivery is not. `set` is 380 µs at
1 KB and 3 120 µs at 10 KB, and lands synchronously on the owner. Fan-out is free to the publisher;
a delta converges in the same tick at both sizes and both fan-outs. A 100-key boot burst applies in
one tick with nothing dropped. So the rule is about size on the publishing side: keep shared values
small, and put anything per-player behind an rpc method instead.

## Non-goals

- Reading a peer's *documents* here. Those are an rpc answer; this is a mirror of small values.
- Persistence. That is db's.
- A schema, or partial writes. A shared value is one JSON-serializable thing under one key.
- Replacing scoreboards for anything commands or JSON UI must read.
