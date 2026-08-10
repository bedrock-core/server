---
'@bedrock-core/server-runtime': minor
---

Initial release.

The framework runtime on top of `@bedrock-core/sync`. An addon declares everything it needs in one `core.register()` call — there is no separate `start()`:

```ts
import { core } from '@bedrock-core/server-runtime';

const config = core.register({
  creator: 'bt',
  pack: 'gc_shop',
  packName: 'My Cool Shop',
  version: '1.2.0',
  dependencies: ['os_bc_economy'],
  config: { server: { taxRate: { type: 'number', default: 0.05, min: 0, max: 1, label: 'Tax Rate' } } },
});

config.server.get().taxRate;
```

**Identity is one Minecraft namespace**, declared as `creator` + `pack` and joined as `creator_pack` (`bt_gc_shop`). That single id is the sync transport id, the replicated-state namespace, and the namespace of every custom command and command enum the addon registers — Bedrock allows a pack exactly one of the last, and requires no two packs to share it, which is the same uniqueness the registry enforces. `core.id` reads it back.

Included:

- **Registry** — enumerate registered peers, react to `onRegister` and `onNamespaceCollision`.
- **Host election** — `core.host` elects the realm running the newest runtime, so work only one realm may do (rendering the shared UI) follows the newest build rather than load order.
- **Features** — enable and disable behaviour based on which peers are present.
- **Config** — server / dimension / player scopes with typed accessors and live change subscriptions. Reads and writes made on a player's behalf carry an `actorId` the owning addon authorizes: server and dimension writes need an operator, and a non-operator reaches only their own player scope. Access with no actor is an addon acting for itself and stays unrestricted. Operator status is read from the readonly `playerPermissionLevel`, never the script-writable `commandPermissionLevel`. `core.config.local` exposes this addon's own scopes synchronously, for startup-time consumers such as generated config commands.
- **Translations** — per-locale keys shared across addons' UIs.
- **Guides** — compiled in-game guides, declared at registration.
- **Manifest validation** — `validateManifest` enforces the `creator` / `pack` id rules.

`rpc` and `state` are re-exposed with your namespace pre-filled.
