# @bedrock-core/server-runtime

The bedrock-core **server runtime** — the framework layer addons build on.

Where [`@bedrock-core/sync`](https://github.com/bedrock-core/server/tree/main/packages/sync) is the low-level transport (bus, discovery, RPC,
state), the runtime is the thing you *register into*. An addon declares its identity and
manifest once, and that declaration flows into a **cross-addon registry** — a live directory
of every bedrock-core addon present in the world.

---

## Register

Import the `core` singleton and register once near the top of your script entry.
**`register()` brings the addon online — there is no separate `start()`.** Everything the
addon *declares* rides in the one call: identity, plus the optional `translations`, `guide`,
and `config` fields (each is sugar for the corresponding standalone call, documented below).

```ts
import { core } from '@bedrock-core/server-runtime';
import bundle from '@bedrock-core/generated/i18n';
import guides from '@bedrock-core/generated/guides';

const config = core.register({
  creator: 'ms',                   // creator/vendor id — [a-z0-9_]+
  pack: 'shop',                // abbreviated pack id — [a-z0-9_]+
  packName: 'My Cool Shop',       // display label only — not part of identity
  version: '1.0.0',
  description: 'Sells items',
  dependencies: ['os_economy'],      // namespaces you need (soft — logs, never blocks)
  optionalDependencies: ['os_leaderboard'], // namespaces that unlock optional features
  translations: bundle,          // optional — the i18n filter's bundle (see Translations)
  guide: guides,                 // optional — compiled guide manifest (see Guides)
  config: { /* schema */ },      // optional — config schema (see Config)
});

// When `config` is given, register() returns the typed scope accessors —
// the same value core.config.define() would return.

console.warn(core.id);          // 'ms_shop' — this addon's namespace
console.warn(core.namespace);   // same value; an alias that reads better in some places
```

### Identity: one namespace, declared as `creator` + `pack`

Minecraft requires every item in an add-on to share a single namespace, no two packs to share
one, and recommends it read as creator-then-pack. @bedrock-core follows that exactly: `creator`
and `pack` are separate fields, both `[a-z0-9_]+`, joined as `${creator}_${pack}` (e.g.
`ms_shop`) to form **the** identifier the addon is known by.

That one namespace is the sync transport id, the replicated-state namespace, the namespace of
any custom command the addon registers, and the namespace of any command enum it registers —
Bedrock allows a pack exactly one of the last, which is the constraint that makes a single id
not merely tidy but required.

- A creator shipping several addons uses distinct `pack` ids (`ms_shop`, `ms_economy`) —
  different namespaces → they coexist.
- Two addons with the **same creator AND pack** → a collision: the runtime logs an error and
  fires `core.registry.onNamespaceCollision(info => …)`.

`packName` and `creatorName` are purely human-readable display labels and play no part in
identity; the optional `icon` (an RP texture path such as `textures/ui/my_addon_logo`) is what
the registry UI shows beside them. `register()` validates the manifest and throws on a bad
manifest or a second call.

---

## The registry

```ts
core.registry.all();                       // RegisteredAddon[] — self + all live peers
core.registry.get('os_economy'); // by namespace
core.registry.has('os_economy'); // is it present?

core.registry.onRegister(addon => console.warn('joined:', addon.id));
core.registry.onUnregister(addon => console.warn('left:', addon.id));
core.registry.onNamespaceCollision(info => console.error('collision on', info.id));
```

Every `RegisteredAddon` carries the full manifest plus its `id` (the namespace,
`creator_pack`) and a `self` flag.

### Dependencies (soft, by namespace)

Dependencies are declared and matched by namespace (`creator_pack`):

```ts
core.registry.missingDependencies();           // ['os_economy'] until it registers
core.registry.onDependenciesSatisfied(() => enableThingsNeedingEconomy());
```

An info line is logged while a declared dependency is absent (and again when it resolves);
nothing ever blocks.

### Optional dependencies → togglable features

Declare a feature that auto-enables when its condition is met and auto-disables when it
isn't. The condition is re-evaluated on every registry or state change:

```ts
core.features.add('leaderboard-sync', {
  // ctx.registry — live addon registry
  // ctx.state    — raw sync state (read any addon's published values)
  // ctx.feature  — check another addon's published feature state
  condition: ctx => ctx.registry.has('os_leaderboard'),
  onEnable() { startSyncingScores(); },
  onDisable() { stopSyncingScores(); },
});

// Condition combining registry presence AND another addon's feature state:
core.features.add('cross-pvp', {
  condition: ctx =>
    ctx.registry.has('os_pvp') &&
    ctx.feature('os_pvp', 'arena-mode'),
  onEnable() { /* … */ },
  onDisable() { /* … */ },
});

// Condition driven by a raw state value:
core.features.add('shop-integration', {
  condition: ctx => ctx.state.get('os_shop', 'shopOpen') === true,
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
const shopFeatures = core.features.of<ShopFeatures>('os_shop');
shopFeatures.isEnabled('discount-mode');         // type-checked
shopFeatures.isEnabled('unknown-feature');       // TS error
```

---

## Messaging and state

The runtime exposes the underlying `sync` node's RPC and state directly:

```ts
// RPC — use the target's namespace (creator_pack)
core.rpc.onRequest('buy', params => purchase(params));
const balance = await core.rpc.request('os_economy', 'getBalance', { player: 'Steve' });

// State — scoped to this addon's namespace
core.state.set('open', true);                      // sets in your namespace
core.state.subscribe(({ key, value }) => {
  /* persist here — already filtered to your namespace */
});

core.node;         // the raw sync node (bus, discovery) for advanced use
core.node.state;   // the unscoped store — other addons' namespaces, and your own `core-` keys
```

`core.state` is scoped in both directions: reads, writes and `subscribe` see only what your addon
wrote, never the framework's own `core-` keys (config schema, translations, guide, feature
flags) that replicate under the same namespace. That is what makes
`core.state.getNamespace()` safe to serialize whole. Reach past the scope with `core.node.state`.

See the [`@bedrock-core/sync` README](https://github.com/bedrock-core/server/tree/main/packages/sync#readme)
for messaging/state semantics and how an addon persists its own state.

---

## Host election

Some work may only be done by one realm — rendering the shared config/guide UI is the case that
motivated this. `core.host` picks that realm: the one running the **newest**
`@bedrock-core/server-runtime`, ties broken by the lowest namespace. Every realm sees the same
registry and applies the same rule, so they agree without exchanging a single negotiation
message, and the pick is redone whenever an addon appears or disappears.

```ts
if (core.host.isHost) {
  renderLocally(player);
} else {
  await core.rpc.request(core.host.hostId, 'core:open-ui', { playerId: player.id });
}

core.host.hostId;    // namespace of the elected realm
core.host.host;      // its RegisteredAddon entry, while it is present
core.host.subscribe((hostId, previousHostId) => console.warn('UI host is now', hostId));
```

Newest-wins is the point: a world holding one addon built last year and one built today serves
today's UI to both. The version being compared is `RUNTIME_VERSION`, exported alongside
`compareVersions` so you can apply the same ordering yourself.

Hosting is not the same as owning the command. Bedrock's custom-command registry is world-global
and `registerCommand` throws on a duplicate name, so whichever realm loads first owns
`core:config` forever — there is no unregister API and no way to move it. What moves is the
rendering: the command owner forwards to `core.host.hostId`.

---

## Config

An addon declares its config schema once — via the `config` field of `core.register()` (or
`core.config.define()` to define late). Values are returned as structured nested objects and
stored per-key in dynamic properties. Discovery is push, values
are pull: only the (small, static) schema is broadcast over `sync` state — its presence is the
"this addon has config" signal and lets a UI build forms without a round trip — while values
are fetched on demand via RPC, so config causes zero steady-state traffic. Three independent
scopes:

| Scope | Shared across… | Access |
|---|---|---|
| `server` | whole world | `config.server` |
| `dimension` | per dimension (schema default until overridden) | `config.dimension.for(dim)` |
| `player` | per player (schema default until overridden) | `config.player.for(player)` |

Each scope is a **dotted accessor tree** mirroring the schema. Every node — group or leaf —
carries its own verbs, in the style of `world.afterEvents.playerSpawn.subscribe(...)`:

```ts
config.server.pricing.taxRate.get()            // number
config.server.pricing.taxRate.set(0.1)
config.server.pricing.taxRate.subscribe((next, prev) => { /* … */ })
config.server.pricing.subscribe(pricing => { /* … */ })   // group level
config.player.for(player).allowGifts.get()                // entity scopes pick the entity first
```

The tree is materialized once, when the schema is registered — it is real objects, not a
`Proxy`, so `config.server.a.b.get()` in a tick loop is three property lookups and a call.

Two write operations, same semantics everywhere (local and cross-addon):

- **`patch(partial)`** — deep-merge; every part of the object is optional, only the provided
  keys change.
- **`set(value)`** — full replace; requires the whole object. Any schema key missing from the
  payload at runtime reverts to its schema default and its persisted override is deleted.

### Schema declaration

```ts
const config = core.register({
  // ...identity fields...
  config: {
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

`get`, `set`, `patch`, `subscribe` and `for` are **reserved** and cannot be schema keys at any
depth — they are the verbs each accessor node carries. A schema that uses one is rejected at
registration, naming the offending path.

Persisted values load one tick after the schema is defined (dynamic properties are readable
from tick 1 onward). Reads before that return schema defaults; when loading completes, change
listeners fire for every key whose persisted value differs — a subscriber attached right
after registration always ends up seeing the real values.

`core.config.local` hands back this addon's own scope accessors — the same object `register()`
returned — synchronously, or `undefined` before the schema is defined. Unlike `core.config.of()`
it doesn't wait for the schema to reach replicated state a tick later, which is what makes it
usable from startup-time consumers such as command registration.

### Server scope

```ts
// Walk to the node you mean — leaves are typed exactly (this one is 'emerald' | 'gold' | 'diamond')
config.server.pricing.currency.get();
config.server.pricing.currency.set('gold');
config.server.pricing.patch({ taxRate: 0.1 });         // groups patch and set too

// The whole scope, as a fully typed nested object
const cfg = config.server.get();
console.warn(cfg.pricing.taxRate);   // number

config.server.patch({ pricing: { taxRate: 0.1 } });
config.server.set({ pricing: { taxRate: 0.1, currency: 'gold', shopEnabled: true } });

// Change listeners — root, group, or leaf; listeners bubble up
config.server.subscribe(full => console.warn(full.pricing.taxRate));         // root
config.server.pricing.subscribe(s => console.warn(s.taxRate));               // group
config.server.pricing.taxRate.subscribe((next, prev) => { /* … */ });        // leaf

// Escape hatch: a dot-path, still type-checked, for paths computed at runtime
config.server.subscribe('pricing.taxRate', (next, prev) => { /* … */ });
```

### Dimension / player scopes

`for(entity)` picks the entity and hands back the same tree the server scope is, so both
scopes read identically past that point. An entity without a stored override resolves to the
**schema default**.

```ts
config.dimension.for(dim).miningBonus.get()       // → number
config.dimension.for(dim).miningBonus.set(2.0)
config.dimension.for(dim).get()                   // → { miningBonus: number } — the whole scope

config.player.for(player).allowGifts.subscribe((next, prev) => { /* … */ })
config.player.for(player).subscribe(full => { /* … */ })
config.player.for(player).subscribe('allowGifts', (next, prev) => { /* … */ })
```

The entity-first `get(entity)` / `patch(entity, …)` / `set(entity, …)` remain for callers
holding an untyped scope, such as `core.config.local`.

### Cross-addon access

Read and write another addon's config over RPC — typed if you have its `ConfigDefinition`
type. `of()` answers synchronously (from the published schema) whether the addon has config;
value reads are async:

```ts
// undefined until the addon publishes its schema
const shopCfg = core.config.of<ShopConfigDef>('vendor_shop');
(await shopCfg?.server.get())?.pricing.taxRate;

// Subscribe — fires immediately if already online, then again on re-publish
core.config.subscribe<ShopConfigDef>('vendor_shop', async (shopCfg) => {
  const cfg = await shopCfg.server.get();
  console.warn(`shop taxRate = ${String(cfg?.pricing.taxRate)}`);
});
```

Omit the type parameter for untyped (`unknown`) access. The provider validates and persists
writes; every `patch`/`set` resolves with the updated effective values, so callers get
read-after-write in one round trip.

#### Acting on behalf of a player

Pass `{ actorId }` whenever the access is driven by a player — a UI screen, a config command —
and the owning addon authorizes it against that player:

```ts
const shopCfg = core.config.of<ShopConfigDef>('vendor_shop', { actorId: player.id });
await shopCfg?.server.patch({ pricing: { taxRate: 0.1 } });   // refused unless the player is an operator
```

The rule the provider applies, on every write and on player-scope reads:

- **No `actorId`** → allowed. That is an addon acting programmatically, not a player.
- **Operator** → allowed in every scope.
- **Anyone else** → their own `player` scope only; `server` and `dimension` are refused.
- **Actor not in the world** → refused, because it can't be verified.

Operator status is read from the readonly `playerPermissionLevel`, never the script-writable
`commandPermissionLevel` — authorization must not rest on a value another addon can hand itself.
Note what this is: a **player** boundary, not a pack boundary. Every addon in the world can write
the underlying dynamic properties directly, so nothing here defends against a hostile pack; it
stops a player driving the UI from changing settings that aren't theirs.

### Publishing a config type

Export your `ConfigDefinition` type from a shared types package so consumers can get
fully-typed access:

```ts
// In your addon (e.g. @drav0011/shop)
export const configDef = { server: { pricing: { taxRate: { type: 'number', default: 0.05, … } } } } as const;
export type ShopConfigDef = typeof configDef;
// in the script entry:
const config = core.register({ /* ...identity... */, config: configDef });

// In a consumer
import type { ShopConfigDef } from '@drav0011/shop-types';
core.config.subscribe<ShopConfigDef>('drav0011_shop', async (shopCfg) => {
  (await shopCfg.server.get())?.pricing.taxRate;  // number — fully typed
});
```

---

## Translations

Registry display fields (`packName`, `description`, `creatorName`) are translation keys shipped
in each addon's RP `.lang`. So that any addon can resolve and measure another's strings
server-side, each one publishes its **i18n bundle** — the module the
[`i18n` Regolith filter](https://github.com/bedrock-core/regolith-filters/tree/main/i18n)
generates — to replicated state:

```ts
import bundle from '@bedrock-core/generated/i18n';

core.register({ ..., translations: bundle });     // publish this addon's i18n bundle
core.translations.provide(bundle);                // or publish/replace later

// Verbs over one peer's strings — t/key/raw/resolve/display, as createI18n gives that addon
core.translations.of('vendor_shop')?.t('shop.title');
core.translations.bundleOf('vendor_shop');        // the raw published bundle, or undefined

// Resolvers chaining every published bundle
const resolve = core.translations.forPlayer(player);  // the player's locale
const enUS = core.translations.forLocale('en_US');    // one specific locale
resolve('vendor_shop.shop.title');                    // string | undefined

core.translations.subscribe(() => { ... });        // any addon re-published
```

`forPlayer` / `forLocale` return a **resolver function**, not a merged table — nothing is
flattened or copied, each lookup reads the winning bundle's own objects and converts the one
template it needs. It takes a real `.lang` key (namespace included), which is what makes it the
contract for server-side text measurement. Repeated keys go to whichever addon registered later,
mirroring Bedrock's own world-level `.lang` merge.

A peer's verbs are loosely typed: their resource tree's compile-time types never travel over the
wire, so paths are plain strings there. `forPlayer` picks the locale through the same chain the
i18n engine uses — persisted override → client locale → sibling region of that language →
`en_US` → anything published.

---

## Guides

An addon publishes its compiled guide manifest (the `guides` Regolith filter output) once;
it replicates cross-addon so a host addon can list and render every guide locally:

```ts
import guides from '@bedrock-core/generated/guides';

core.register({ ..., guide: guides });  // publish this addon's guide
core.guides.provideManifest(guides);   // or publish/replace later

core.guides.own();                     // this addon's manifest
core.guides.of('vendor_shop');      // another addon's manifest, or undefined
core.guides.addonsWithGuides();        // every addon that published one
core.guides.subscribe(() => { ... });   // any addon re-published
```

---

## Testing

The `Runtime` class stands alone, so a GameTest can create **several runtimes in one script
realm** — they talk over the real `system` bus, and each `register()` brings it online:

```ts
import { Runtime } from '@bedrock-core/server-runtime';

const a = new Runtime();
a.register({ creator: 'test', pack: 'demo_a', packName: 'A', version: '1.0.0' });
const b = new Runtime();
b.register({ creator: 'test', pack: 'demo_b', packName: 'B', version: '1.0.0' });
// a.id = 'test_demo_a', b.id = 'test_demo_b'
// advance ticks in a GameTest sequence, then assert on a.registry / a.rpc / a.state
```

The `core` singleton is the one you use in a real addon (one identity per pack). See
[`packages/test-addon`](https://github.com/bedrock-core/server/tree/main/packages/test-addon) for
GameTests covering discovery, RPC, state, collisions and features.
