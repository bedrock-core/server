# @bedrock-core/server-runtime

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The framework runtime beneath `@bedrock-core/server`. It gives each addon an identity, discovers
other Bedrock Core addons across isolated script realms, and provides the registry, RPC, shared
state, events, local persistence, feature flags, translations, and runtime declaration slots.

Most addons should install `@bedrock-core/server`, which pins compatible versions of the full
stack and re-exports this package. Install `@bedrock-core/server-runtime` directly when building a
framework layer on top of the runtime.

## Install

```sh
yarn add @bedrock-core/server-runtime
```

`@minecraft/server` is a peer dependency. Pin the version that your behavior pack declares in
`manifest.json`.

## Usage

Call `register()` exactly once. Values beside `manifest` must be declarations such as
`registerShared()` and `registerEvents()`; `register()` installs them and returns their typed
accessors.

```ts
import {
  authorize,
  core,
  event,
  players,
  registerEvents,
  registerShared,
  schema,
} from '@bedrock-core/server-runtime';
import { world } from '@minecraft/server';

const sharedDef = {
  currency: 'gold',
  sale: { item: '', active: false },
};

const eventsDef = {
  purchase: event<{ playerId: string; amount: number }>(),
};

const { shared, events } = core.register({
  manifest: {
    creator: 'drav0011',
    pack: 'economy',
    packName: 'Economy',
    version: '1.0.0',
    dependencies: ['os_shop'],
  },
  shared: registerShared(sharedDef),
  events: registerEvents(eventsDef),
});

const balances = core.db.collection('balances', {
  schema: schema<{ amount: number }>({ defaults: { amount: 0 } }),
  accept: players(),
});

interface EconomyApi {
  getBalance(params: { playerId: string; actorId?: string }): number;
}

core.rpc.serve<EconomyApi>({
  getBalance: ({ playerId, actorId }) => {
    authorize({ entity: playerId }, actorId, 'read');

    const player = world.getAllPlayers().find(candidate => candidate.id === playerId);

    if (player === undefined) { return 0; }

    return balances.for(player).get()?.amount ?? 0;
  },
});

shared.currency.set('emerald');
events.purchase.emit({ playerId: 'player-id', amount: 5 });

core.registry.addons.subscribe(addons => console.warn('online:', addons.length));
core.shared.of<typeof sharedDef>('os_shop')?.currency.subscribe(console.warn);
```

The runtime provides three cross-addon channels:

- Shared values are observable live state. The owner writes; peers receive read-only trees.
- Events are broadcasts delivered once and never replayed.
- RPC handles requests and responses. An owner can expose local database data through typed methods.

`core.db` remains local to the addon and persists documents on Minecraft dynamic properties. A
peer can access that data only through an API the owner explicitly serves.

Config, Catalog, and Guides are packages above the runtime. They contribute declarations and use
runtime slots; they are not properties of `core`.

## Documentation

https://bedrock-core.drav.dev/docs/server/api/runtime

## License

MIT
