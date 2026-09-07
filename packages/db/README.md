# @bedrock-core/db

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

Persisted documents on dynamic properties. The engine offers two ABIs for them — six methods on
the world, entities and container slots; three on a block entity's component — and nothing at all
on a dimension or a vanilla block. This package puts one adapter over all of it, a **resolver**
that decides, per target, where a document can live, and typed **collections** on top.

## Install

```bash
yarn add @bedrock-core/db
```

`@minecraft/server` (`>=2.8.0`) is a peer dependency; block entities need `2.10.0` (Minecraft 1.26.50).

## Collections

```ts
import { createEngineDb } from '@bedrock-core/db/minecraft';
import { blockTypes, schema } from '@bedrock-core/db';

const db = createEngineDb('drav0011_economy');

// No acceptor: any storable target. The schema names the document type.
const balances = db.collection('balances', { schema: schema<{ gold: number; lastSeen: number }>() });

balances.for(player).get();                 // undefined until written; cached after the first read
balances.for(player).patch({ gold: 10 });   // written through, one dynamic property
balances.for(player).subscribe(doc => hud.refresh(doc));

// With an acceptor `for()` only takes a Block, and `require` is checked against what a Block can do.
const elevators = db.collection('elevators', {
  schema: schema<ElevatorDoc>({
    version: 3,
    defaults: { configured: false, facing: 'north' },
    migrate: {
      2: doc => ({ ...doc, facing: doc.facingDirection ?? 'north' }),
      3: ({ legacyMode: _, ...rest }) => rest,
    },
  }),
  accept: blockTypes('papi:elevator'),
  require: { own: true },                   // refuse a vanilla block instead of storing on the world
});

elevators.for(block).set({ configured: true, facing: 'east' });
elevators.where(stone);                     // { ok: false, reason: "minecraft:stone is not accepted by 'elevators'" }
```

- **One JSON string per document**, `{"v":3,"d":{…}}`. The version travels with the bytes, so an
  old document is migrated **lazily, on first read**, step by step, and rewritten once. `defaults`
  fill missing keys on read and are never stored.
- **A document that cannot be read is quarantined** under `<key>#bad` and logged, never deleted.
- **Budget checked before the engine sees it.** A block entity holds ~950 bytes per pack; more
  throws `DbBudgetError` naming the collection. On the world, entities and slots a document past
  32 767 characters is chunked into `<key>#0..n` transparently.
- **`all()` walks an index, never the world's property ids.** The identities of a collection's
  documents live in chunked world properties, kept by the first write, `delete`, and `blockCleanup`
  — the custom component to register and list on every accepted block type, whose `onBreak` fires
  for every removal. A block found replaced by another type heals out of the index. The iterator is
  resumable: take a few per tick.
- **`coalesce: true` is write-behind**: one property write per dirty document per tick. Offered on
  the world and on entities only — a block or slot document could die with its target before the
  flush, so those are refused with a reason. An entity that unloads before the flush has its
  document parked and written on `entityLoad`; a leaving player is flushed in `beforeEvents.playerLeave`.
- **Measured in the engine**, 1 000 operations each: `for(player).get()` 14 ms, write-through
  `patch` 28 ms against 12 ms for a raw property write, coalesced `patch` 6 ms, a block document
  91 µs to create and 56 µs to visit through `all()`. Hold a handle when hammering one target: it
  resolves its target once per tick.
- **Every operation re-resolves the target**, at most once per tick. A handle from `for()` keeps an identity, not the
  object: `get()` is `undefined` and `set()` throws `DbTargetError` once an entity is removed, a
  slot empties, or a block's chunk unloads — except a proxied document (dimension, vanilla block),
  which lives on the world and stays reachable. `available` and `reason` expose the gate.
- **The document type is named once, in `schema<T>()`**, never as a type argument: TypeScript
  infers all of a call's type arguments or none, and the acceptor and `require` have to be inferred
  for the static check to run. A `require` the target type can never satisfy (`own` on a dimension,
  `readableWhenUnloaded` on an entity) is a compile error whose missing-property name is the reason.

## The resolver

```ts
import { createEngineResolver } from '@bedrock-core/db/minecraft';

const resolver = createEngineResolver('drav0011_economy');

const r = resolver.resolve(block);
if (r.ok) {
  r.host.caps;              // { own, enumerable, budget, readableWhenUnloaded, batch }
  r.host.write('doc', json);
} else {
  r.reason;                 // e.g. "a stackable item (minecraft:stone) cannot hold dynamic properties"
}
```

Nothing is declared. A target is probed once **per type** — a block type either has a
`minecraft:block_entity` or it does not, an item type is either stackable or not — and the
decision is cached; a throw (a block in an unloaded chunk) is never cached.

| Target | Host | Why |
| --- | --- | --- |
| `World`, `Entity`, `Player` | `own`, direct ABI | six methods, 32 767 characters per value |
| `ContainerSlot` with a non-stackable item | `own`, direct ABI | the slot is the item's place; a stackable item refuses properties |
| block whose type declares `minecraft:block_entity` | `own`, component ABI | ~950 bytes per block, dies with the block |
| `Dimension`, vanilla block | `proxied` | a world property keyed by the target's identity |
| `ItemStack` | **refused** | a detached copy — the write never reaches the world |

The main entry is structural and runs without the engine (the tests use stubs); the `/minecraft`
entry adds the `instanceof` classifier, the locator that finds an entity by id and a block by
location again, and the world.

## Documentation

Design notes, measurements and the collection API that sits on top live in the repository's
`docs/` while this package is being built.

## License

MIT
