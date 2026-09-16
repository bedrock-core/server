# @bedrock-core/server-runtime

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The bedrock-core **server runtime** — the framework layer addons build on, on top of
`@bedrock-core/sync`. Every behavior pack runs its scripts in its own isolated realm, so two
addons in the same world normally cannot see each other at all; where sync is the low-level
transport that breaks that isolation, the runtime is the thing you *register into* — an addon
declares its identity and its data once, and that declaration flows into a **cross-addon
registry**, a live directory of every bedrock-core addon present in the world.

## Install

```bash
yarn add @bedrock-core/server-runtime
```

`@minecraft/server` is a peer dependency — it stays yours to pin, since the version you build
against has to match the one your pack's `manifest.json` declares.

## Usage

```ts
import { authorize, core, event, players, schema } from '@bedrock-core/server-runtime';

// register() declares everything and brings the addon online. It returns the typed accessors of
// what was declared, one key each.
const { shared, events } = core.register({
  manifest: {
    creator: 'drav0011',          // creator/vendor id — [a-z0-9_]+
    pack: 'economy',              // abbreviated pack id — together: namespace `drav0011_economy`
    packName: 'Economy',          // display label only, never part of identity
    version: '1.0.0',
    dependencies: ['os_shop'],    // namespaces you need — soft, logs, never blocks
  },
  shared: {                       // optional — what every realm mirrors; only this one writes it
    currency: 'gold',
    event: { name: 'none', active: false },   // one key, one value, written whole
  },
  events: {                       // optional — what this addon announces to every realm
    purchase: event<{ playerId: string; gold: number }>(),
  },
});

// Persisted documents keyed by target, on the target's own dynamic properties. Local.
const balances = core.db.collection('balances', { schema: schema<{ gold: number }>(), accept: players() });
balances.for(player).patch({ gold: 10 });

// What peers may ask for, and the one player rule every handler applies. Export the interface so
// a peer gets a typed client from core.rpc.typed<EconomyApi>('drav0011_economy').
export interface EconomyApi { balance(p: { playerId: string; actorId?: string }): { gold: number } | undefined }

core.rpc.serve<EconomyApi>({
  balance: ({ playerId, actorId }) => {
    authorize({ entity: playerId }, actorId, 'read');

    return balances.for(playerOf(playerId)).get();
  },
});

shared.currency.set('emerald');       // every realm sees it this tick
events.purchase.emit({ playerId: player.id, gold: 5 });   // announced once, kept by nobody
shared.event.subscribe(event => console.warn('event', event.name, event.active));

// A peer's shared tree, typed by the declaration the peer exports. Read-only: only an owner writes.
core.shared.of<ShopShared>('os_shop')?.stock.subscribe(stock => console.warn('stock', stock));

// A peer's events. Attaching before that addon exists is fine — an event missed is missed for good.
core.events.of<ShopEvents>('os_shop').sale.subscribe(({ item }) => console.warn('sold', item));

core.registry.onRegister(addon => console.warn('joined:', addon.id));

// And an action that is not data at all.
core.rpc.onRequest('openShop', ({ playerId }) => openFor(playerId));
core.rpc.request('os_shop', 'openShop', { playerId }).catch(console.warn);
```

## Documentation

https://bedrock-core.drav.dev/docs/server

## License

MIT
