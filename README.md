# @bedrock-core/server

A modular collection of TypeScript packages for Minecraft Bedrock addon development, designed to enable easier cross-addon compatibility and cleaner architecture.

Each package provides a focused abstraction layer over the `@minecraft/server` API, allowing developers to build more maintainable and interoperable addons.

## Features

- 🔗 **Cross-addon compatibility** - Build addons that work seamlessly together
- 📦 **Modular packages** - Use only what you need, when you need it
- 🎯 **Type-safe APIs** - Full TypeScript support with strict typing
- 🧪 **Battle-tested** - Verified in-game with GameTests
- 🎨 **Clean code** - Enforced code quality with ESLint + Stylistic
- 🚀 **Bundle-ready** - Designed to be bundled into your addon projects

## Packages

### `@bedrock-core/sync`

The low-level cross-addon transport library, and the first layer directly on
`@minecraft/server`. Each addon runs in its own isolated script realm, so the only shared
channels are script events and scoreboards. This package layers a message bus, peer
discovery, request/response RPC and a replicated key/value state on top of script events, so
bedrock-core addons can find each other and exchange data.

- **Bus** — one script-event channel, JSON envelopes, automatic chunking/reassembly for
  payloads larger than the engine's message limit, and a rate-limited outbound queue.
- **Discovery** — `announce`/`whois` handshake with heartbeats and TTL, so even late-loading
  addons can enumerate their peers.
- **RPC** — `request()` / `onRequest()` with correlation ids and tick-based timeouts.
- **State** — shared-mutable replicated KV (last-write-wins). It's an in-memory channel;
  persistence is each addon's own responsibility (via `onChange` + its dynamic properties).

```ts
import { createSync } from '@bedrock-core/sync';

const sync = createSync({ id: 'myaddon', version: '1.0.0' });
sync.start();

sync.rpc.onRequest('ping', () => 'pong');
sync.state.set('myaddon', 'volume', 5);
```

### `@bedrock-core/server-runtime`

The framework runtime addons build on — analogous to how `@minecraft/server` is the thing
you register into. An addon declares its identity + base data once; that flows into a
**cross-addon registry** of every bedrock-core addon present in the world. Built on `sync`.
Identity is **`creator` + `namespace`** (both `[a-z0-9_]+`). The transport id is derived as
`creator:namespace` (e.g. `my_studio:bc_shop`) and is what `core.id` returns. `core.namespace`
returns just the namespace — use it for state keys and dependency declarations. `name` and
`creatorName` are purely display labels. `register()` brings the addon online; no separate `start()`.

```ts
import { core } from '@bedrock-core/server-runtime';

core.register({
  creator: 'my_studio',       // vendor/creator id — [a-z0-9_]+
  namespace: 'bc_shop',       // addon id — [a-z0-9_]+
  name: 'My Cool Shop',       // display label only
  version: '1.2.0',
  dependencies: ['other_studio:bc_economy'],
  optionalDependencies: ['other_studio:bc_leaderboard'],
});

// core.id        → 'my_studio:bc_shop'  (transport id — use for RPC targeting)
// core.namespace → 'bc_shop'            (namespace — use for state keys and dependencies)

core.registry.all();                               // every registered addon (self + peers)
core.registry.onRegister(addon => /* … */ {});
core.registry.onDependenciesSatisfied(() => /* … */ {});
core.registry.onNamespaceCollision(info => /* … */ {});
core.feature('lb-sync', { condition: r => r.has('other_studio:bc_leaderboard'), onEnable() {}, onDisable() {} });
core.rpc.onRequest('buy', params => purchase(params));
core.state.set('open', true);                      // scoped to your namespace automatically
```

### `@bedrock-core/server-test-addon` + `@bedrock-core/server-test-addon-2`

Two reference addons — "Economy" and "Shop" — that register with the runtime and demonstrate
cross-addon discovery, RPC, shared state, dependencies and features. They also host the
in-game **GameTests** for the whole stack (`/gametest runset bc`). `yarn watch` builds and
watches both at once.

### Development

```bash
# Install dependencies
yarn install

# Type-check / build all library packages
yarn build

# Lint code
yarn lint

# Build + watch both test addons (re-bundles them when the libraries change)
yarn watch
```

The libraries (`sync`, `server-runtime`) are type-checked with `tsc`. There are no headless
unit tests — correctness is verified **in-game with GameTests** shipped in the test addons
(`/gametest runset bc`).

## License

MIT
