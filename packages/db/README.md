# @bedrock-core/db

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

Persisted documents on dynamic properties for `@bedrock-core/server`. The engine offers two ABIs
for them — six methods on the world, entities and container slots; three on a block entity's
component — and nothing at all on a dimension or a vanilla block; this package puts one adapter
over all of it, a **resolver** that decides, per target, where a document can live, and typed
**collections** on top, local by design so nothing in one reaches another realm unless the addon
answers an rpc method over it.

## Install

```bash
yarn add @bedrock-core/db
```

`@minecraft/server` is a peer dependency, pinned to what your manifest declares; block entities
need a manifest new enough to support the block-entity component.

## Usage

```ts
import { createEngineDb } from '@bedrock-core/db/minecraft';
import { schema } from '@bedrock-core/db';

const db = createEngineDb('drav0011_economy');

const balances = db.collection('balances', { schema: schema<{ gold: number; lastSeen: number }>() });

balances.for(player).get();                 // undefined until written; cached after the first read
balances.for(player).patch({ gold: 10 });   // written through, one dynamic property; merges deep
balances.for(player).subscribe(doc => hud.refresh(doc));
```

## Documentation

https://bedrock-core.drav.dev/docs/db

## License

MIT
