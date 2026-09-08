# @bedrock-core/server-runtime

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The bedrock-core **server runtime** — the framework layer addons build on.

Every behavior pack runs its scripts in its own isolated realm, so two addons in the same world
normally cannot see each other at all. Where [`@bedrock-core/sync`](https://bedrock-core.drav.dev/docs/server/sync)
is the low-level transport that breaks that isolation, the runtime is the thing you *register into*:
an addon declares its identity and its data once, and that declaration flows into a **cross-addon
registry** — a live directory of every bedrock-core addon present in the world.

## Install

```bash
yarn add @bedrock-core/server-runtime
```

`@minecraft/server` is a peer dependency (`>=2.8.0`) — it stays yours to pin, since the version you
build against has to match the one your pack's `manifest.json` declares.

## What it gives you

- **`core.register()`** — one call brings the addon online (there is no separate `start()`).
  Identity is `creator` + `pack`, joined into the single namespace Bedrock requires an addon to use
  for its items, its commands and its command enum
- **A registry** — `core.registry` lists every addon in the world, fires on join/leave, reports
  namespace collisions, and tracks soft dependencies by namespace
- **Features** — `core.features.add()` declares a capability that auto-enables when its condition
  holds, driven by registry presence, replicated state, or another addon's published features
- **Config** — declare a schema once and get typed accessor trees over three scopes (`server`,
  `dimension`, `player`), each a db document with a form on top, readable and writable cross-addon
  over db's RPC with player-level authorization
- **Translations and guides** — publish your i18n bundle and compiled guide manifest, and resolve
  any peer's strings server-side for text measurement
- **Host election** — `core.host` picks the realm running the newest runtime, with no negotiation
  messages, so exactly one realm serves shared UI for the whole world
- **Messaging and the shared mirror** — `core.rpc`, and a `shared` shape declared in `register()` that every realm mirrors as a typed tree (`core.shared.of()` for a peer's), with the
  raw sync node available at `core.node`
- **Events** — declare what this addon announces in `register({ events })`, `emit` it, and any realm listens with `core.events.of()`; delivered in the same tick and kept by nobody
- **Documents** — `core.db`, this addon's `@bedrock-core/db`: typed, versioned documents keyed by player, entity, block or world, stored on whatever the target itself can hold; local until the addon answers an rpc method over it

## Usage

```ts
import { authorize, core, event, players, schema } from '@bedrock-core/server-runtime';
import bundle from '@bedrock-core/generated/i18n';
import guides from '@bedrock-core/generated/guides';

// register() declares everything and brings the addon online. It returns the typed accessors of
// what was declared, one key each: `config` and `shared`.
const { config, shared } = core.register({
  manifest: {
    creator: 'drav0011',          // creator/vendor id — [a-z0-9_]+
    pack: 'economy',              // abbreviated pack id — together: namespace `drav0011_economy`
    packName: 'Economy',          // display label only, never part of identity
    version: '1.0.0',
    dependencies: ['os_shop'],    // namespaces you need — soft, logs, never blocks
  },
  translations: bundle,           // optional — the i18n filter's bundle
  guide: guides,                  // optional — the guides filter's manifest
  config: {                       // optional — config schema
    server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } },
  },
  shared: {                       // optional — what every realm mirrors; only this one writes it
    currency: 'gold',
    event: { name: 'none', active: false },   // one key, one value, written whole
  },
  events: {                       // optional — what this addon announces to every realm
    purchase: event<{ playerId: string; gold: number }>(),
  },
});

config.server.taxRate.get();          // 0.05 — typed all the way down
config.server.taxRate.subscribe((next, prev) => console.warn('tax', prev, '→', next));

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

- [server-runtime](https://bedrock-core.drav.dev/docs/server/server-runtime) — the `core`
  singleton, `register()`, every manifest field, and running several runtimes in one realm
- [Registry](https://bedrock-core.drav.dev/docs/server/server-runtime/registry) ·
  [Features](https://bedrock-core.drav.dev/docs/server/server-runtime/features) ·
  [Host election](https://bedrock-core.drav.dev/docs/server/server-runtime/host)
- [Config](https://bedrock-core.drav.dev/docs/server/server-runtime/config) — schemas, the three
  scopes, cross-addon access, authorization
- [Translations](https://bedrock-core.drav.dev/docs/server/server-runtime/translations) ·
  [Guides](https://bedrock-core.drav.dev/docs/server/server-runtime/guides) ·
  [Shared](https://bedrock-core.drav.dev/docs/server/server-runtime/shared) ·
  [Events](https://bedrock-core.drav.dev/docs/server/server-runtime/events)
- [UI integration](https://bedrock-core.drav.dev/docs/server/ui-integration) — what the runtime
  publishes and which UI package draws it

`packages/test-addon` and `packages/test-addon-2` in this repository are two real addons wired to
each other, with GameTests covering discovery, RPC, the shared mirror, collisions and features.

## License

MIT
