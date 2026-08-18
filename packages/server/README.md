# @bedrock-core/server

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The meta package for the [bedrock-core](https://github.com/bedrock-core/server) server stack. One
dependency gets you a matching, known-good set of the server packages — each release pins the exact
versions of the underlying ones, so upgrading `@bedrock-core/server` moves the whole stack together.

## Install

```bash
yarn add @bedrock-core/server
```

`@minecraft/server` is a peer dependency (`>=2.8.0`) — it stays yours to pin, since the version you
build against has to match the one your pack's `manifest.json` declares.

## What you get

- **`@bedrock-core/server`** re-exports
  [`@bedrock-core/server-runtime`](https://bedrock-core.drav.dev/docs/server/server-runtime) — the
  framework runtime: addon registration, the cross-addon registry, features, config, guides,
  translations and RPC. This is what most addons import.
- **`@bedrock-core/server/sync`** re-exports
  [`@bedrock-core/sync`](https://bedrock-core.drav.dev/docs/server/sync) — the low-level cross-addon
  transport (message bus, peer discovery, RPC, replicated state), for when you need to talk to it
  directly rather than through the runtime.

## Usage

```ts
import { core } from '@bedrock-core/server';

core.register({
  creator: 'ms',
  creatorName: 'My Studio',
  pack: 'shop',
  packName: 'My Shop',
  version: '1.0.0',
});

// Only if you need the transport itself:
// import { createSync } from '@bedrock-core/server/sync';
```

## Documentation

- [Get started](https://bedrock-core.drav.dev/docs/server/get-started/overview) — two addons
  talking to each other, end to end
- [server-runtime](https://bedrock-core.drav.dev/docs/server/server-runtime) ·
  [sync](https://bedrock-core.drav.dev/docs/server/sync)
- [UI integration](https://bedrock-core.drav.dev/docs/server/ui-integration) — pairing the server
  packages with the `@bedrock-core` UI packages

## License

MIT
