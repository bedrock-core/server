# @bedrock-core/server-runtime

![Logo](https://raw.githubusercontent.com/bedrock-core/server/main/assets/logo/title.png)

The bedrock-core **server runtime** — the framework layer addons build on.

Every behavior pack runs its scripts in its own isolated realm, so two addons in the same world
normally cannot see each other at all. Where [`@bedrock-core/sync`](https://bedrock-core.drav.dev/docs/server/sync)
is the low-level transport that breaks that isolation, the runtime is the thing you *register into*:
an addon declares its identity and its data once, and that declaration flows into a **cross-addon
registry** — a live directory of every bedrock-core addon present in the world.

## Install

```bash
yarn add @bedrock-core/server-runtime
```

`@minecraft/server` is a peer dependency (`>=2.8.0`) — it stays yours to pin, since the version you
build against has to match the one your pack's `manifest.json` declares.

## What it gives you

- **`core.register()`** — one call brings the addon online (there is no separate `start()`).
  Identity is `creator` + `pack`, joined into the single namespace Bedrock requires an addon to use
  for its items, its commands and its command enum
- **A registry** — `core.registry` lists every addon in the world, fires on join/leave, reports
  namespace collisions, and tracks soft dependencies by namespace
- **Features** — `core.features.add()` declares a capability that auto-enables when its condition
  holds, driven by registry presence, replicated state, or another addon's published features
- **Config** — declare a schema once and get typed accessor trees over three scopes (`server`,
  `dimension`, `player`), persisted in dynamic properties, readable and writable cross-addon over
  RPC with player-level authorization
- **Translations and guides** — publish your i18n bundle and compiled guide manifest, and resolve
  any peer's strings server-side for text measurement
- **Host election** — `core.host` picks the realm running the newest runtime, with no negotiation
  messages, so exactly one realm serves shared UI for the whole world
- **Messaging and state** — `core.rpc` and a `core.state` scoped to your own namespace, with the
  raw sync node available at `core.node`

## Usage

```ts
import { core } from '@bedrock-core/server-runtime';
import bundle from '@bedrock-core/generated/i18n';
import guides from '@bedrock-core/generated/guides';

// register() declares everything and brings the addon online. When `config` is given it
// returns the typed scope accessors — the same value core.config.define() would return.
const config = core.register({
  creator: 'drav0011',            // creator/vendor id — [a-z0-9_]+
  pack: 'economy',                // abbreviated pack id — together: namespace `drav0011_economy`
  packName: 'Economy',            // display label only, never part of identity
  version: '1.0.0',
  dependencies: ['os_shop'],      // namespaces you need — soft, logs, never blocks
  translations: bundle,           // optional — the i18n filter's bundle
  guide: guides,                  // optional — the guides filter's manifest
  config: {                       // optional — config schema
    server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } },
  },
});

config.server.taxRate.get();          // 0.05 — typed all the way down
config.server.taxRate.subscribe((next, prev) => console.warn('tax', prev, '→', next));

core.registry.onRegister(addon => console.warn('joined:', addon.id));

// Serve a method to other addons, and call one of theirs.
core.rpc.onRequest('getRate', () => config.server.taxRate.get());
core.rpc.request('os_shop', 'getStock', {}).then(stock => console.warn('stock', stock));
```

## Documentation

- [server-runtime](https://bedrock-core.drav.dev/docs/server/server-runtime) — the `core`
  singleton, `register()`, every manifest field, and running several runtimes in one realm
- [Registry](https://bedrock-core.drav.dev/docs/server/server-runtime/registry) ·
  [Features](https://bedrock-core.drav.dev/docs/server/server-runtime/features) ·
  [Host election](https://bedrock-core.drav.dev/docs/server/server-runtime/host)
- [Config](https://bedrock-core.drav.dev/docs/server/server-runtime/config) — schemas, the three
  scopes, cross-addon access, authorization
- [Translations](https://bedrock-core.drav.dev/docs/server/server-runtime/translations) ·
  [Guides](https://bedrock-core.drav.dev/docs/server/server-runtime/guides) ·
  [Scoped state](https://bedrock-core.drav.dev/docs/server/server-runtime/scoped-state)
- [UI integration](https://bedrock-core.drav.dev/docs/server/ui-integration) — what the runtime
  publishes and which UI package draws it

`packages/test-addon` and `packages/test-addon-2` in this repository are two real addons wired to
each other, with GameTests covering discovery, RPC, state, collisions and features.

## License

MIT
