# @bedrock-core/sync

> **For framework / library developers.**  
> If you're building a Bedrock addon, you don't need this package directly — use
> [`@bedrock-core/server-runtime`](../server-runtime) instead. `server-runtime` creates and
> manages the one sync node for you; raw transport access is available via `core.node` when
> you need it.

Cross-addon transport for Minecraft Bedrock. Every behavior pack runs its scripts in its
**own isolated QuickJS realm** — the only things that can cross between realms are script
events and scoreboards. `@bedrock-core/sync` builds a clean layer on top of script events:

- **Discovery** — find other bedrock-core nodes in the world (heartbeat, whois, TTL eviction)
- **RPC** — call a named method on another node and await the response
- **State** — a replicated key/value store every node mirrors locally; writes broadcast a delta

> sync does **not** touch dynamic properties — they're pack-scoped and persistence is each
> addon's own responsibility.

---

## When to use this directly

The typical cases:

- You're **building a library or framework layer** on top of `sync` (like `server-runtime`
  itself does).
- You need **raw bus / discovery / state access** in an addon that already uses
  `server-runtime` — use `core.node` for that, no extra install needed.
- You're writing **GameTests** that spin up multiple isolated nodes in one realm to exercise
  the protocol.

You do **not** need to create a second `SyncNode` just to read another addon's state — the
state store is globally shared-mutable, so `core.node.state.get('other_addon', 'key')` works
from the one node you already have.

---

## Install

```jsonc
{
  "dependencies": {
    "@bedrock-core/sync": "workspace:^",
    "@minecraft/server": "2.8.0"
  }
}
```

---

## Quick start

Create **one** `SyncNode` for the process, call `start()` once on boot:

```ts
import { createSync } from '@bedrock-core/sync';

export const sync = createSync({
  id: 'mycoolitems',    // unique, stable id (a-z0-9_) — transport address + default state namespace
  version: '1.0.0',
  meta: { /* opaque data peers see in PeerInfo.meta */ },
});

sync.start();
```

After `start()`, `sync.discovery`, `sync.rpc`, and `sync.state` are live.

---

## Discovery

```ts
sync.discovery.onPeerUp(peer => {
  console.warn(`${peer.id} v${peer.version} joined`);
});
sync.discovery.onPeerDown(peer => console.warn(`${peer.id} left`));

const peers = sync.discovery.peers;
const economy = sync.discovery.getPeer('economy');
```

Addons load in undefined order; sync handles that automatically: each node re-announces on a
heartbeat and broadcasts a whois on startup so late-loading nodes catch up. Peers that go
quiet are evicted after a TTL.

---

## RPC

```ts
// Expose a method:
sync.rpc.onRequest('getBalance', async (params, from) => {
  return lookupBalance((params as { player: string }).player);
});

// Call another node:
const balance = await sync.rpc.request('economy', 'getBalance', { player: 'Steve' });
```

Requests always time out (default 5 s / 100 ticks), so an absent peer can never hang your code.

---

## State

State is replicated — every node keeps a full in-memory mirror. Reads are local and
synchronous; writes broadcast a delta.

```ts
sync.state.set('mycoolitems', 'spawnRate', 5);
const rate = sync.state.get('mycoolitems', 'spawnRate');      // 5
const all  = sync.state.getNamespace('economy');              // { currency: 'gold', ... }

sync.state.onChange(({ ns, key, value, deleted }) => { /* … */ });
sync.state.delete('mycoolitems', 'spawnRate');
```

**Typed keys.** Plain string keys read as `unknown`. Declare a key with `stateKey<T>()` and
`get` infers the value type while `set` type-checks it (a compile-time assertion only — peers
are not validated):

```ts
import { stateKey } from '@bedrock-core/sync';

const SPAWN_RATE = stateKey<number>('spawnRate');
sync.state.set('mycoolitems', SPAWN_RATE, 5);                 // value must be number
const rate = sync.state.get('mycoolitems', SPAWN_RATE);       // number | undefined
```

**Writes are open** — any node may write any namespace (shared-mutable). Conflicts resolve
last-write-wins on a Lamport clock. A node answers late-join snapshot requests for its
`ownedNamespaces` (default `[id]`).

**Persistence is the addon's job.** sync is in-memory only. To persist, subscribe to
`onChange`, write to your pack's own dynamic properties, and re-publish on load (defer with
`system.run` — dynamic properties can't be touched during early execution):

```ts
import { system, world } from '@minecraft/server';

system.run(() => {
  const NS = 'mycoolitems';
  const saved = world.getDynamicProperty(`${NS}:save`);
  if (typeof saved === 'string') {
    for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, unknown>)) {
      sync.state.set(NS, k, v);
    }
  }
  sync.state.onChange(change => {
    if (change.ns !== NS) return;
    world.setDynamicProperty(`${NS}:save`, JSON.stringify(sync.state.getNamespace(NS)));
  });
});
```

---

## Things to know

- **One node per realm.** Creating multiple `SyncNode`s with different ids in one realm is
  only useful for in-realm testing — use `server-runtime` and `core.node` in production addons.
- **Timing is tick-based.** Messages flush over ticks; you will never get an RPC reply on the
  same tick you sent.
- **Large payloads are fine.** Frames above the engine size limit are split and reassembled transparently.

## Testing

sync is tested **in-game with GameTests**. Several nodes in one realm all share the real
`system` bus, so a test can create multiple `SyncNode`s and assert discovery, RPC and state
convergence — see `packages/test-addon*`.
