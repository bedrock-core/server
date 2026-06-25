# @bedrock-core/server-runtime

The bedrock-core **server runtime** — the framework layer addons build on.

Where [`@bedrock-core/sync`](../sync) is the low-level transport (bus, discovery, RPC,
state), the runtime is the thing you *register into*. An addon declares its identity and
manifest once, and that declaration flows into a **cross-addon registry** — a live directory
of every bedrock-core addon present in the world.

> Config (schemas, values, a config/guide UI) is **not** here. It will be its own package
> built on top of this runtime, using `sync` to share config across addons.

---

## Register

Import the `core` singleton and register once near the top of your script entry.
**`register()` brings the addon online — there is no separate `start()`.**

```ts
import { core } from '@bedrock-core/server-runtime';

core.register({
  creator: 'my_studio',           // creator/vendor id — [a-z0-9_]+
  namespace: 'bc_shop',           // addon id — [a-z0-9_]+
  name: 'My Cool Shop',           // display label only — not part of identity
  version: '1.0.0',
  description: 'Sells items',
  dependencies: ['other_studio:bc_economy'],      // transport ids you need (soft — warns, never blocks)
  optionalDependencies: ['other_studio:bc_leaderboard'], // transport ids that unlock optional features
});

console.warn(core.id);          // 'my_studio:bc_shop' — transport id (creator:namespace)
console.warn(core.namespace);   // 'bc_shop' — just the namespace
```

### Identity: `creator` + `namespace`

Identity is the combination of `creator` and `namespace` — both separate fields, both
`[a-z0-9_]+` (lowercase alphanumeric and underscores, no spaces). The transport id is derived
as `${creator}:${namespace}` (e.g. `my_studio:bc_shop`).

- A creator shipping several addons uses distinct namespaces under the same creator id
  (`my_studio:bc_shop`, `my_studio:bc_economy`) — different transport ids → they coexist.
- Two addons with the **same creator AND namespace** → a collision: the runtime logs an error
  and fires `core.registry.onNamespaceCollision(info => …)`.

`name` is purely the human-readable display label and plays no part in identity. `register()`
validates the manifest and throws on a bad manifest or a second call.

#### `core.id` vs `core.namespace`

| Getter | Value | Use for |
|---|---|---|
| `core.id` | `'my_studio:bc_shop'` | RPC targeting, registry lookup |
| `core.namespace` | `'bc_shop'` | State keys, dependency declarations, persistence filter |

---

## The registry

```ts
core.registry.all();                       // RegisteredAddon[] — self + all live peers
core.registry.get('other_studio:bc_economy'); // by transport id
core.registry.has('other_studio:bc_economy'); // is it present?

core.registry.onRegister(addon => console.warn('joined:', addon.id));
core.registry.onUnregister(addon => console.warn('left:', addon.id));
core.registry.onNamespaceCollision(info => console.error('collision on', info.id));
```

Every `RegisteredAddon` carries the full manifest plus its `id` (transport id:
`creator:namespace`), `namespace`, and a `self` flag.

### Dependencies (soft, by namespace)

```ts
core.registry.missingDependencies();           // ['bc_economy'] until it registers
core.registry.onDependenciesSatisfied(() => enableThingsNeedingEconomy());
```

A warning is logged while a declared dependency is absent; nothing ever blocks.

### Optional dependencies → togglable features

Declare a feature that auto-enables when its required namespaces are all present and
auto-disables when any drops out:

```ts
core.feature('leaderboard-sync', {
  condition: r => r.has('other_studio:bc_leaderboard'),
  onEnable() { startSyncingScores(); },
  onDisable() { stopSyncingScores(); },
});
```

---

## Messaging and state

The runtime exposes the underlying `sync` node's RPC and state directly:

```ts
// RPC — use the target's transport id (creator:namespace)
core.rpc.onRequest('buy', params => purchase(params));
const balance = await core.rpc.request('other_studio:bc_economy', 'getBalance', { player: 'Steve' });

// State — use core.namespace (not core.id) as the state key
core.state.set('open', true);                      // sets in your namespace
core.state.onChange(({ ns, key, value }) => {
  if (ns !== core.namespace) return;               // filter to own namespace
  /* persist here */
});

core.node;   // the raw sync node (bus, discovery) for advanced use
```

See the [`@bedrock-core/sync` README](../sync/README.md) for messaging/state semantics and
how an addon persists its own state.

---

## BOR enrichment

`@bedrock-core/server-runtime` bundles [`@bedrock-oss/add-on-registry`](https://github.com/Bedrock-OSS/addon-registry)
as a dependency. When a peer's addon namespace appears in that registry, the runtime
automatically fills in its `name` (if the peer didn't broadcast one) and `creatorName`
(if not already set). No configuration needed.

---

## Testing

The `Runtime` class stands alone, so a GameTest can create **several runtimes in one script
realm** — they talk over the real `system` bus, and each `register()` brings it online:

```ts
import { Runtime } from '@bedrock-core/server-runtime';

const a = new Runtime();
a.register({ creator: 'test', namespace: 'demo_a', name: 'A', version: '1.0.0' });
const b = new Runtime();
b.register({ creator: 'test', namespace: 'demo_b', name: 'B', version: '1.0.0' });
// a.id = 'test:demo_a', b.id = 'test:demo_b'
// advance ticks in a GameTest sequence, then assert on a.registry / a.rpc / a.state
```

The `core` singleton is the one you use in a real addon (one identity per pack). See
`packages/test-addon` for GameTests covering discovery, RPC, state, collisions and features.
