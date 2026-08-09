---
'@bedrock-core/server': minor
---

Initial release.

The meta package: one install that curates matching versions of the server stack. It re-exports the runtime at the root, and the transport at the `/sync` subpath for when you need the bus, discovery, RPC or replicated state directly.

```ts
import { core } from '@bedrock-core/server';

const config = core.register({ creator: 'my_studio', namespace: 'bc_shop', name: 'My Shop', version: '1.0.0' });
```

Most addons should depend on this rather than on `@bedrock-core/server-runtime` and `@bedrock-core/sync` separately.
