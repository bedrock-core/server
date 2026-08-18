# @bedrock-core/sync

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

> **For framework and library developers.**
> If you are building a Bedrock addon, you do not need this package directly — use
> [`@bedrock-core/server-runtime`](https://bedrock-core.drav.dev/docs/server/server-runtime)
> instead. The runtime creates and manages the one sync node for you, and raw transport access is
> available as `core.node` whenever you want it.

Cross-addon transport for Minecraft Bedrock. Every behavior pack runs its scripts in its **own
isolated QuickJS realm** — the only things that cross between realms are script events and
scoreboards. `@bedrock-core/sync` builds a usable layer on top of script events so addons in
separate realms can actually talk.

## Install

```bash
yarn add @bedrock-core/sync
```

`@minecraft/server` is a peer dependency (`>=2.8.0`) — it stays yours to pin, since the version you
build against has to match the one your pack's `manifest.json` declares.

## What it gives you

- **Discovery** — find the other bedrock-core nodes in the world, with heartbeats, a startup whois
  so late loaders catch up, and TTL eviction for nodes that go quiet
- **RPC** — call a named method on another node and await the reply. Requests always time out, so
  an absent peer can never hang your code; a node may address itself, and that call is delivered
  locally on the next tick
- **State** — a replicated key/value store every node mirrors in full. Reads are local and
  synchronous, writes broadcast a delta, conflicts resolve last-write-wins on a Lamport clock, and
  `stateKey<T>()` makes a key's value type check at compile time
- **Framing you do not have to think about** — payloads above the engine's frame limit are split
  and reassembled transparently

sync does **not** touch dynamic properties. It is in-memory only; persistence is each addon's own
responsibility (subscribe, write to your pack's dynamic properties, re-publish on load).

## Usage

Create **one** `SyncNode` for the realm and call `start()` once on boot:

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

sync.state.set(NS, SPAWN_RATE, 5);                     // value must be a number
sync.state.subscribe(change => { /* persist your own namespace here */ });

sync.rpc.onRequest('getSpawnRate', () => sync.state.get(NS, SPAWN_RATE));
sync.rpc.request('economy', 'getBalance', { player: 'Steve' }).then(b => console.warn(b));
```

Writes are open — any node may write any namespace — and timing is tick-based, so you will never
get an RPC reply on the tick you sent it.

## Documentation

- [sync](https://bedrock-core.drav.dev/docs/server/sync) — when to use it directly, `SyncNodeOptions`,
  the `SyncNode` surface
- [Discovery](https://bedrock-core.drav.dev/docs/server/sync/discovery) ·
  [RPC](https://bedrock-core.drav.dev/docs/server/sync/rpc) ·
  [State](https://bedrock-core.drav.dev/docs/server/sync/state)
- [Protocol](https://bedrock-core.drav.dev/docs/server/sync/protocol) — the envelope, framing and
  wire behavior

sync is tested **in-game with GameTests**: several nodes in one realm share the real `system` bus,
so a test can assert discovery, RPC and state convergence for real. See `packages/test-addon` and
`packages/test-addon-2` in this repository.

## License

MIT
