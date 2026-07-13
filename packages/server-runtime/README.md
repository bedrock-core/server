# @bedrock-core/server-runtime

The bedrock-core **server runtime** — the framework layer addons build on.

Where [`@bedrock-core/sync`](../sync) is the low-level transport (bus, discovery, RPC,
state), the runtime is the thing you *register into*. An addon declares its identity and
manifest once, and that declaration flows into a **cross-addon registry** — a live directory
of every bedrock-core addon present in the world.

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
| `core.id` | `'my_studio:bc_shop'` | RPC targeting, registry lookup, dependency declarations |
| `core.namespace` | `'bc_shop'` | State keys, persistence filter |

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

### Dependencies (soft, by transport id)

Dependencies are declared and matched by transport id (`creator:namespace`):

```ts
core.registry.missingDependencies();           // ['other_studio:bc_economy'] until it registers
core.registry.onDependenciesSatisfied(() => enableThingsNeedingEconomy());
```

A warning is logged while a declared dependency is absent; nothing ever blocks.

### Optional dependencies → togglable features

Declare a feature that auto-enables when its condition is met and auto-disables when it
isn't. The condition is re-evaluated on every registry or state change:

```ts
core.feature('leaderboard-sync', {
  // ctx.registry — live addon registry
  // ctx.state    — raw sync state (read any addon's published values)
  // ctx.feature  — check another addon's published feature state
  condition: ctx => ctx.registry.has('other_studio:bc_leaderboard'),
  onEnable() { startSyncingScores(); },
  onDisable() { stopSyncingScores(); },
});

// Condition combining registry presence AND another addon's feature state:
core.feature('cross-pvp', {
  condition: ctx =>
    ctx.registry.has('other_studio:bc_pvp') &&
    ctx.feature('other_studio:bc_pvp', 'arena-mode'),
  onEnable() { /* … */ },
  onDisable() { /* … */ },
});

// Condition driven by a raw state value:
core.feature('shop-integration', {
  condition: ctx => ctx.state.get('other_studio:bc_shop', 'shopOpen') === true,
  onEnable() { /* … */ },
  onDisable() { /* … */ },
});
```

Each addon's feature states are published to sync state automatically, so other addons can
observe them. Outside of conditions, use `core.features`:

```ts
// Check your own features
core.features.isEnabled('leaderboard-sync');     // boolean

// Typed read of another addon's features
type ShopFeatures = 'discount-mode' | 'leaderboard-sync';
const shopFeatures = core.features.of<ShopFeatures>('other_studio:bc_shop');
shopFeatures.isEnabled('discount-mode');         // type-checked
shopFeatures.isEnabled('unknown-feature');       // TS error
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

## Config

An addon declares its config schema once with `core.config.define()`. Values are returned as
structured nested objects and stored per-key in dynamic properties. Discovery is push, values
are pull: only the (small, static) schema is broadcast over `sync` state — its presence is the
"this addon has config" signal and lets a UI build forms without a round trip — while values
are fetched on demand via RPC, so config causes zero steady-state traffic. Three independent
scopes:

| Scope | Shared across… | Access |
|---|---|---|
| `server` | whole world | `config.server` |
| `dimension` | per dimension (schema default until overridden) | `config.dimension` |
| `player` | per player (schema default until overridden) | `config.player` |

Two write operations, same semantics everywhere (local and cross-addon):

- **`patch(partial)`** — deep-merge; every part of the object is optional, only the provided
  keys change.
- **`set(value)`** — full replace; requires the whole object. Any schema key missing from the
  payload at runtime reverts to its schema default and its persisted override is deleted.

### Schema declaration

```ts
const config = core.config.define({
  server: {
    pricing: {
      taxRate:    { type: 'number',  default: 0.05, min: 0, max: 1, step: 0.01, label: 'Tax Rate' },
      currency:   { type: 'enum',   default: 'emerald', options: ['emerald', 'gold', 'diamond'] as const, label: 'Currency' },
      shopEnabled:{ type: 'boolean', default: true, label: 'Shop Enabled' },
    },
  },
  dimension: {
    miningBonus: { type: 'number', default: 1.0, min: 0, max: 5, label: 'Mining Bonus' },
  },
  player: {
    allowGifts:      { type: 'boolean', default: true,     label: 'Allow Gifts' },
    displayCurrency: { type: 'enum',    default: 'symbol', options: ['symbol', 'name', 'both'] as const, label: 'Display' },
  },
});
```

Supported entry types: `'boolean'`, `'number'` (`min`, `max`, `step`), `'string'`
(`maxLength`), `'enum'` (`options: readonly string[]`), and `'list'` (`itemType: 'string' |
'enum'`, `options`, `maxItems` — an ordered string array, stored as a JSON string). All
entries support `label` and `description`. The schema describes data only — the UI layer
picks the control for each entry type.

Groups can be nested to any depth. The schema is published on `sync` state as a flat map
(keys prefixed `server.` / `dimension.` / `player.`) so a UI addon can enumerate every field
without knowing the provider in advance.

Persisted values load one tick after `define()` (dynamic properties are readable from tick 1
onward). Reads before that return schema defaults; when loading completes, change listeners
fire for every key whose persisted value differs — a subscriber attached right after
`define()` always ends up seeing the real values.

### Server scope

```ts
// Read — returns a fully typed nested object
const cfg = config.server.get();
console.warn(cfg.pricing.taxRate);   // number

// Write — deep-merge (patch, all keys optional) or full replace (set, whole object)
config.server.patch({ pricing: { taxRate: 0.1 } });
config.server.set({ pricing: { taxRate: 0.1, currency: 'gold', shopEnabled: true } });

// Change listeners — root, group, or leaf; listeners bubble up
config.server.onChange(full => console.warn(full.pricing.taxRate));          // root
config.server.onChange('pricing', s => console.warn(s.taxRate));             // group
config.server.onChange('pricing.taxRate', (next, prev) => { /* … */ });      // leaf
```

### Dimension / player scopes

Both scopes share the same API — the entity (`Dimension` or `Player`) is the first argument.
An entity without a stored override resolves to the **schema default**.

```ts
// Per-entity read / write
config.dimension.get(dim)                         // → { miningBonus: number }
config.dimension.patch(dim, { miningBonus: 2.0 })
config.dimension.set(dim, { miningBonus: 3.0 })

// Change listeners — same depth support, entity-scoped
config.player.onChange(player, (full) => { /* … */ })
config.player.onChange(player, 'allowGifts', (next, prev) => { /* … */ })
```

### Cross-addon access

Read and write another addon's config over RPC — typed if you have its `ConfigDefinition`
type. `of()` answers synchronously (from the published schema) whether the addon has config;
value reads are async:

```ts
// undefined until the addon publishes its schema
const shopCfg = core.config.of<ShopConfigDef>('vendor:bc_shop');
(await shopCfg?.server.get())?.pricing.taxRate;

// Subscribe — fires immediately if already online, then again on re-publish
core.config.subscribe<ShopConfigDef>('vendor:bc_shop', async (shopCfg) => {
  const cfg = await shopCfg.server.get();
  console.warn(`shop taxRate = ${String(cfg?.pricing.taxRate)}`);
});
```

Omit the type parameter for untyped (`unknown`) access. The provider validates and persists
writes; every `patch`/`set` resolves with the updated effective values, so callers get
read-after-write in one round trip.

### Publishing a config type

Export your `ConfigDefinition` type from a shared types package so consumers can get
fully-typed access:

```ts
// In your addon (e.g. @drav0011/bc-shop)
const configDef = { server: { pricing: { taxRate: { type: 'number', default: 0.05, … } } } } as const;
export type ShopConfigDef = typeof configDef;
export const config = core.config.define(configDef);

// In a consumer
import type { ShopConfigDef } from '@drav0011/bc-shop-types';
core.config.subscribe<ShopConfigDef>('drav0011:bc_shop', async (shopCfg) => {
  (await shopCfg.server.get())?.pricing.taxRate;  // number — fully typed
});
```

---

## Translations

Registry display fields (`name`, `description`, `creatorName`) are translation keys shipped
in each addon's RP `.lang`. For server-side text measurement, each addon also publishes its
generated by-locale key map to replicated state; the runtime merges every addon's map per
locale:

```ts
import translationKeys from '@bedrock-core/generated/translation-keys';

core.register({ ... });
core.translations.provide(translationKeys);   // publish this addon's full by-locale map

core.translations.forPlayer(player);          // merged flat map for the player's locale
core.translations.forLocale('en_US');         // merged flat map for one locale
core.translations.onChange(() => { ... });    // any addon re-published
```

Repeated keys are overridden by whichever addon merges later — mirroring Bedrock's own
world-level `.lang` merge.

---

## Guides

An addon publishes its compiled guide manifest (the `guides` Regolith filter output) once;
it replicates cross-addon so a host addon can list and render every guide locally:

```ts
import guides from '@bedrock-core/generated/guides';

core.register({ ... });
core.guide(guides);                    // publish (calling again replaces)

core.guides.own();                     // this addon's manifest
core.guides.of('vendor:bc_shop');      // another addon's manifest, or undefined
core.guides.addonsWithGuides();        // every addon that published one
core.guides.onChange(() => { ... });   // any addon re-published
```

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
