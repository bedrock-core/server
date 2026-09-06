# @bedrock-core/db

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

Persisted documents on dynamic properties. The engine offers two ABIs for them — six methods on
the world, entities and container slots; three on a block entity's component — and nothing at all
on a dimension or a vanilla block. This package puts one adapter over all of it and a **resolver**
that decides, per target, where a document can live.

## Install

```bash
yarn add @bedrock-core/db
```

`@minecraft/server` (`>=2.8.0`) is a peer dependency; block entities need `2.10.0` (Minecraft 1.26.50).

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
entry adds the `instanceof` classifier and the world.

## Documentation

Design notes, measurements and the collection API that sits on top live in the repository's
`docs/` while this package is being built.

## License

MIT
