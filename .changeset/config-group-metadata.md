---
'@bedrock-core/server-runtime': minor
---

Named config groups, and a `multiselect` entry type.

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
