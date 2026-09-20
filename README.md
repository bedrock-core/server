# @bedrock-core/server

![@bedrock-core](./assets/logo/title.png)

> ⚠️ Beta status: the API may change before 1.0.0. Pin exact versions for stability.

The meta package for Bedrock Core's server stack. It lets Minecraft Bedrock addons in separate script realms discover each other, exchange typed messages, share live state, and persist their own data.

## Install

```sh
yarn add @bedrock-core/server
```

`@minecraft/server` is a peer dependency. Pin the version that your behavior pack declares in
`manifest.json`. `@minecraft/server-ui` is an optional peer dependency.

The package ships TypeScript source, so your behavior-pack build must compile dependencies from
`node_modules`. The Bedrock Core Regolith bundler filter handles this automatically.

## Usage

Call `register()` once near the top of your script entry. It validates the manifest, brings the
addon online, and installs each declaration in the same call.

```ts
import { core, event, registerEvents, registerShared } from '@bedrock-core/server';

const sharedDef = {
  currency: 'gold',
  sale: { item: '', active: false },
};

const eventsDef = {
  purchase: event<{ playerId: string; amount: number }>(),
};

const { shared, events } = core.register({
  manifest: {
    creator: 'ms',
    pack: 'shop',
    packName: 'My Shop',
    version: '1.0.0',
    dependencies: ['os_economy'], // Soft dependency: warns while absent, never blocks startup.
  },
  shared: registerShared(sharedDef),
  events: registerEvents(eventsDef),
});

shared.currency.set('emerald');
events.purchase.emit({ playerId: 'player-id', amount: 5 });

core.registry.addons.subscribe(addons => console.warn(`${String(addons.length)} addons online`));
await core.rpc.request('os_economy', 'getBalance', { playerId: 'player-id' });
```

The namespace is `creator_pack`; the example above registers as `ms_shop`. Shared values are live
mirrors and do not persist across reloads. Use `core.db` for persisted documents, events for
one-time broadcasts, and RPC for requests that need a response.

Settings, catalog entries, and guides live in their own packages. They integrate with the same
`register()` call through `registerConfig()`, `registerCatalog()`, and `registerGuides()` rather
than through members on `core`.

## Package entry points

- `@bedrock-core/server` — runtime, registry, declarations, RPC, and database declaration helpers.
- `@bedrock-core/server/sync` — low-level cross-realm transport.
- `@bedrock-core/server/db` — the complete persisted-document API.
- `@bedrock-core/server/observable` — observables, `computed`, `effect`, `last`, and `toNative`.
- `@bedrock-core/server/i18n` — typed translation helpers.

## Documentation

https://bedrock-core.drav.dev/docs/server

## Contributing

Discord: https://bedrock-core.drav.dev/discord

## License

MIT
