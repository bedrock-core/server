# @bedrock-core/server

![@bedrock-core](./assets/logo/title.png)

> ⚠️ Beta Status: Active development. Breaking changes may occur until 1.0.0. Pin exact versions for stability.


A framework for Minecraft Bedrock addon development, built for cross-addon compatibility. Every addon runs in its own isolated script realm — bedrock-core lets addons from different creators find each other, call each other, and share state, settings and guides.

Full documentation & guides: https://bedrock-core.drav.dev/

---

## ✨ Features

- **Addon discovery** — addons announce their identity, version and dependencies, and enumerate their peers at runtime.
- **Replicated state** — shared last-write-wins key/value, scoped to your namespace.
- **Typed RPC** — typed request/response calls between addons, with timeouts.
- **Features** — enable or disable behaviour based on which peers are present.
- **Configuration** — server / dimension / player scopes, with typed accessors and live change subscriptions.
- **Guides** — compiled in-game guides, declared when the addon registers.

## 🚀 Quick start

```sh
yarn add @bedrock-core/server
```

`@minecraft/server` is a peer dependency (`>=2.8.0`) — pin the version your pack's
`manifest.json` declares.

Register once, near the top of your script entry. `register()` is what brings the addon online — there is no separate `start()` — and everything the addon declares rides in that one call:

```ts
import { core } from '@bedrock-core/server';

const config = core.register({
  creator: 'ms',                    // creator id — [a-z0-9_]+
  pack: 'shop',                     // pack id    — [a-z0-9_]+ → namespace `ms_shop`
  packName: 'My Cool Shop',         // display label only, not part of identity
  version: '1.0.0',
  dependencies: ['os_economy'],     // soft — logs while absent, never blocks
  config: {
    server: {
      taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' },
    },
  },
});

config.server.taxRate.get();        // 0.05 — a dotted accessor tree mirroring the schema
config.server.taxRate.subscribe((next, prev) => { /* … */ });

core.registry.all();                // every bedrock-core addon present in the world
core.state.set('open', true);       // replicated under `ms_shop`
await core.rpc.request('os_economy', 'getBalance', { player: 'Steve' });
```

Full API — features, config scopes, translations, guides, host election — in the
[`@bedrock-core/server-runtime` README](./packages/server-runtime/README.md).

## 📦 Packages

- **`@bedrock-core/server`** — the meta package: one install for the whole stack. Re-exports the runtime at the root and the transport at `/sync`.
- **`@bedrock-core/server-runtime`** — the framework runtime: registration, the cross-addon registry, features, config and guides. Built on `sync`.
- **`@bedrock-core/sync`** — the low-level transport: message bus, discovery, RPC and replicated state over script events.

## 🤝 Contributing

Let's talk in Discord: <https://bedrock-core.drav.dev/discord>

## 📄 License

MIT
