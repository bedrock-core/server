---
'@bedrock-core/server-runtime': minor
---

Config scopes are now dotted accessor trees, and `onChange` is `subscribe`.

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
