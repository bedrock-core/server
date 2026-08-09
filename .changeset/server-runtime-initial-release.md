---
'@bedrock-core/server-runtime': minor
---

Initial release.

The framework runtime on top of `@bedrock-core/sync`. An addon declares everything it needs in one `core.register()` call — there is no separate `start()`:

```ts
import { core } from '@bedrock-core/server-runtime';

const config = core.register({
  creator: 'my_studio',
  namespace: 'bc_shop',
  name: 'My Cool Shop',
  version: '1.2.0',
  dependencies: ['other_studio:bc_economy'],
  config: { server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
});

config.server.get().taxRate;
```

Included:

- **Registry** — enumerate registered peers, react to `onRegister` and `onNamespaceCollision`.
- **Features** — enable and disable behaviour based on which peers are present.
- **Config** — server / dimension / player scopes with typed accessors and live change subscriptions.
- **Translations** — per-locale keys shared across addons' UIs.
- **Guides** — compiled in-game guides, declared at registration.
- **Manifest validation** — `validateManifest` enforces the `creator:namespace` id rules.

`rpc` and `state` are re-exposed with your namespace pre-filled.
