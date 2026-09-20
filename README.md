# @bedrock-core/server

![@bedrock-core](./assets/logo/title.png)

> ⚠️ Beta Status: Active development. Breaking changes may occur until 1.0.0. Pin exact versions for stability.

A framework for Minecraft Bedrock addon development, built for cross-addon compatibility: every
addon runs in its own isolated script realm, and bedrock-core lets addons from different creators find each other, call
each other, and share state, settings and guides.

## Install

```sh
yarn add @bedrock-core/server
```

`@minecraft/server` is a peer dependency, pinned to what your pack's `manifest.json` declares.

## Usage

Register once, near the top of your script entry. `register()` is what brings the addon online — there is no separate `start()` — and everything the addon declares rides in that one call:

```ts
import { core } from '@bedrock-core/server';

const { config, shared } = core.register({
  manifest: {
    creator: 'ms',                  // creator id — [a-z0-9_]+
    pack: 'shop',                   // pack id    — [a-z0-9_]+ → namespace `ms_shop`
    packName: 'My Cool Shop',       // display label only, not part of identity
    version: '1.0.0',
    dependencies: ['os_economy'],   // soft — logs while absent, never blocks
  },
  config: {
    server: {
      taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' },
    },
  },
  shared: { open: false },          // what every other realm may read
});

config.server.taxRate.get();        // 0.05 — a dotted accessor tree mirroring the schema
config.server.taxRate.subscribe((next, prev) => { /* … */ });

core.registry.all();                // every bedrock-core addon present in the world
shared.open.set(true);              // every realm sees it this tick
await core.rpc.request('os_economy', 'getBalance', { player: 'Steve' });
```

Each package the runtime is built on has its own subpath, for when you reach past `core` to the
thing itself: `@bedrock-core/server/sync` for the transport, `/db` for the rest of the document
surface, `/observable` for `computed` / `effect` / `last` and the `toNative` bridge to a
data-driven form, and `/i18n` for `createI18n` and the translation verbs.

## Documentation

https://bedrock-core.drav.dev

## Contributing

Discord: https://bedrock-core.drav.dev/discord

## License

MIT
