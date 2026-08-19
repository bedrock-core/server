# @bedrock-core/server-runtime

## 0.1.0

### Minor Changes

- [`6b7f519`](https://github.com/bedrock-core/server/commit/6b7f519dc142a305de07516c34814fb972a875cb) Thanks [@drav0011](https://github.com/drav0011)! - Config scopes are now dotted accessor trees, and `onChange` is `subscribe`.

  **Breaking.** Every config scope mirrors its schema as a tree of nodes, and every node — group or leaf — carries its own verbs, in the style of `world.afterEvents.playerSpawn.subscribe(...)`. You name the value you mean and act on it, instead of naming the scope and describing the value with a string:

  ```ts
  config.server.economy.currency.get();          // 'emerald' | 'gold' | 'diamond'
  config.server.economy.currency.set('gold');
  config.server.economy.currency.subscribe((next, prev) => { ... });
  config.server.economy.subscribe(economy => { ... });   // group level
  config.player.for(player).notifyOnLogin.get();         // entity scopes pick the entity first
  ```

  `config.server.get()` and `config.server.patch({ ... })` are unchanged — the root is just the top node of the same tree, and `patch` / `set` work at every group with the semantics they always had, scoped to that node (`config.server.economy.set({ ... })` reverts only the keys under `economy`).

  **`onChange` is renamed to `subscribe` and removed — there is no alias.** The typed dot-path form survives as the escape hatch for paths computed at runtime, now resolved relative to the node it is called on:

  ```ts
  config.server.subscribe('economy.currency', (next, prev) => { ... });
  config.server.economy.subscribe('currency', (next, prev) => { ... });
  config.player.for(player).subscribe('notifyOnLogin', (next, prev) => { ... });
  ```

  `core.state`, `core.host`, `core.guides` and `core.translations` are different APIs, and they follow — see the runtime-wide `subscribe` rename in this same release.

  **Entity scopes gained `for(entity)`**, which returns the identical tree bound to one entity, so both scopes read the same past that point. The entity-first `get(entity)` / `patch(entity, …)` / `set(entity, …)` remain for callers holding an untyped scope, such as `core.config.local`.

  The tree is **materialized once, at registration** — real objects, walked from the schema, not a `Proxy`. The schema is static and fully known when `define()` runs, so the walk happens exactly once and every later `config.server.a.b.get()` is an ordinary property lookup: the difference matters when config is read on a tick. Per-entity trees are built on first `for()` and cached until the entity leaves; a node stores nothing, resolving values through its scope on every call, so the cache cannot go stale.

  Because the verbs now live on every node, **`get`, `set`, `patch`, `subscribe` and `for` are reserved and cannot be schema keys at any depth**. A schema that uses one is rejected at registration, naming the path:

  ```text
  config schema: "server.economy.set" uses the reserved key "set"; reserved keys are get, set, patch, subscribe, for
  ```

  The list is exported as `RESERVED_KEYS` and the check as `validateConfigSchema(scope, schema)`. New types: `ServerConfigTree`, `ConfigTree`, `ConfigNode`, `ConfigChildren`, `ConfigGroupAccessor`, `ConfigLeafAccessor` and `NodeValue`, all built on the existing `SchemaToValue` / `PathValue` machinery — so a leaf's `get()` narrows exactly as the value does inside `get()` on the whole scope (enums to their literal union, `list` to `string[]`), and an unknown key is a compile error rather than an `undefined`.

- [`36322bb`](https://github.com/bedrock-core/server/commit/36322bb53d4da391170686f124b78c4144d49bf9) Thanks [@drav0011](https://github.com/drav0011)! - Named config groups, and a `multiselect` entry type.

  A schema group can now carry its own display strings:

  ```ts
  server: {
    economy: {
      $label: 'Economy',
      $description: 'Balances, currency and what players may go negative to.',
      balances: {
        startingBalance: { type: 'number', default: 100, min: 0, max: 10000, label: 'Starting Balance' },
      },
    },
  }
  ```

  They are metadata, not settings: `$label` never appears in a value object, is not patchable, and is not a dot-path. The `$` sigil keeps them out of the child namespace, so **no schema key may start with `$`** — `define()` rejects one that does. Groups without them behave exactly as before, deriving a title from the key.

  Group strings publish to a **new** replicated key, `core-config/groups`, keyed by dot-path under the same scope prefixes. `core-config/schema` is untouched, so a consumer that predates this reads it unchanged.

  New **`multiselect`** entry type — any number of a fixed `options` set, valued as `string[]` and stored as that array's JSON, exactly like a `list`. Use it wherever the option set really is fixed; a `list` stays the open-ended one.

  ```ts
  features: { type: 'multiselect', options: ['pvp', 'tp', 'shop'], default: ['pvp'], label: 'Enabled Features' },
  ```

  Internally the inference helpers (`SchemaToValue`, `DotPath`, `PathValue`, `ConfigNode`, `ConfigChildren`) now test a group with `Record<string, unknown>` rather than `Record<string, SchemaNode>`. A named group holds a `string` beside its children, and the stricter test collapsed that group — and everything beneath it — to `never`. A type-test file under `src/config/__type-tests__/` pins the shapes so it cannot regress silently.

- [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f) Thanks [@drav0011](https://github.com/drav0011)! - Initial release.

  The framework runtime on top of `@bedrock-core/sync`. An addon declares everything it needs in one `core.register()` call — there is no separate `start()`:

  ```ts
  import { core } from "@bedrock-core/server-runtime";

  const config = core.register({
    creator: "bt",
    pack: "gc_shop",
    packName: "My Cool Shop",
    version: "1.2.0",
    dependencies: ["os_bc_economy"],
    config: {
      server: {
        taxRate: {
          type: "number",
          default: 0.05,
          min: 0,
          max: 1,
          label: "Tax Rate",
        },
      },
    },
  });

  config.server.get().taxRate;
  ```

  **Identity is one Minecraft namespace**, declared as `creator` + `pack` and joined as `creator_pack` (`bt_gc_shop`). That single id is the sync transport id, the replicated-state namespace, and the namespace of every custom command and command enum the addon registers — Bedrock allows a pack exactly one of the last, and requires no two packs to share it, which is the same uniqueness the registry enforces. `core.id` reads it back.

  Included:

  - **Registry** — enumerate registered peers, react to `onRegister` and `onNamespaceCollision`.
  - **Host election** — `core.host` elects the realm running the newest runtime, so work only one realm may do (rendering the shared UI) follows the newest build rather than load order.
  - **Features** — enable and disable behaviour based on which peers are present.
  - **Config** — server / dimension / player scopes with typed accessors and live change subscriptions. Reads and writes made on a player's behalf carry an `actorId` the owning addon authorizes: server and dimension writes need an operator, and a non-operator reaches only their own player scope. Access with no actor is an addon acting for itself and stays unrestricted. Operator status is read from the readonly `playerPermissionLevel`, never the script-writable `commandPermissionLevel`. `core.config.local` exposes this addon's own scopes synchronously, for startup-time consumers such as generated config commands.
  - **Translations** — i18n bundles replicated whole (`register({ translations: bundle })`, the `@bedrock-core/generated/i18n` module): `core.translations.forPlayer(player)` returns one lazy resolver chaining every addon's published bundle (later registrations win, like Bedrock's world-level `.lang` merge), and `of(addonId)` wraps a peer's bundle in the full verb set (`t`/`key`/`raw`/`resolve`).
  - **Guides** — compiled in-game guides, declared at registration.
  - **Manifest validation** — `validateManifest` enforces the `creator` / `pack` id rules.

  `rpc` and `state` are re-exposed with your namespace pre-filled.

- [`f45e781`](https://github.com/bedrock-core/server/commit/f45e7812d01bf48d0a8e8bece077f2bb44de9f31) Thanks [@drav0011](https://github.com/drav0011)! - Every listener registration in the framework is `subscribe`. `onChange` is gone, with no alias.

  **Breaking.** Config scopes were renamed to `subscribe` in this same release, to match `world.afterEvents.playerSpawn.subscribe(...)` — and then the rest of the stack still said `onChange`, so an addon subscribing to two things wrote the verb two ways for no reason a reader could name. One idiom now, top to bottom:

  ```ts
  core.state.subscribe(({ key, value, deleted }) => {
    /* … */
  }); // ScopedState
  core.host.subscribe((hostId, previousHostId) => {
    /* … */
  }); // HostElection
  core.translations.subscribe(() => {
    /* … */
  }); // TranslationsRegistry
  core.guides.subscribe(() => {
    /* … */
  }); // GuidesRegistry
  core.node.state.subscribe(({ ns, key }) => {
    /* … */
  }); // sync's State, unscoped
  ```

  `sync`'s `State.onChange` moved with them, since the four runtime registrations above are what delegate to it — leaving the bottom of the stack on the old name would have made the persistence pattern in every README read against itself. Nothing else changed: the listener signatures, the filtering `ScopedState` does, the coarse payload-free `TranslationsRegistry` / `GuidesRegistry` notifications, and the `Unsubscribe` return are all as they were, so migrating is renaming the call.

  `Registry` is deliberately untouched. `onRegister`, `onUnregister`, `onNamespaceCollision` and `onDependenciesSatisfied` have the same listener-in / unsubscribe-out shape, but they are four _distinct_ events rather than one "something changed" channel — they cannot all be `subscribe`, and picking one to rename would be worse than leaving the set alone.

### Patch Changes

- Updated dependencies [[`f45e781`](https://github.com/bedrock-core/server/commit/f45e7812d01bf48d0a8e8bece077f2bb44de9f31), [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f)]:
  - @bedrock-core/sync@0.1.0
