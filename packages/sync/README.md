# @bedrock-core/sync

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

Cross-addon transport for Minecraft Bedrock, and the low-level layer `@bedrock-core/server-runtime`
is built on — most addon code should reach for the runtime instead, or for `core.node` when raw
transport access is genuinely needed. Every behavior pack runs its scripts in its own isolated
QuickJS realm, and the only things that cross between realms are script events and scoreboards;
this package builds a usable layer of discovery, RPC and replicated state on top of script events
so addons in separate realms can actually talk. It is in-memory only — persistence is each addon's
own responsibility.

## Install

```bash
yarn add @bedrock-core/sync
```

`@minecraft/server` is a peer dependency — it stays yours to pin, since the version you build
against has to match the one your pack's `manifest.json` declares.

## Usage

```ts
import { createSync, stateKey } from '@bedrock-core/sync';

const NS = 'mycoolitems';
const SPAWN_RATE = stateKey<number>('spawnRate'); // typed key: get infers, set checks

export const sync = createSync({
  id: NS,             // unique, stable id (a-z0-9_) — transport address + default state namespace
  version: '1.0.0',
});

sync.start(); // after this, sync.discovery / sync.rpc / sync.state are live

sync.discovery.onPeerUp(peer => console.warn(`${peer.id} v${peer.version} joined`));

sync.state.set(NS, SPAWN_RATE, 5);                     // value must be a number; mirrors take it because NS is ours
sync.state.subscribe(change => { /* persist your own namespace here */ });

sync.rpc.onRequest('getSpawnRate', () => sync.state.get(NS, SPAWN_RATE));
sync.rpc.request('economy', 'getBalance', { player: 'Steve' }).then(b => console.warn(b));
```

## Documentation

https://bedrock-core.drav.dev/docs/sync

## License

MIT
