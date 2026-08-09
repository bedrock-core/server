---
'@bedrock-core/sync': minor
---

Initial release.

The low-level cross-addon transport. Every addon runs in its own isolated script realm; `sync` layers four things on top of script events so they can reach each other:

- **Bus** — the script-event message bus, with envelopes and chunked sends.
- **Discovery** — peers announce identity and version, and report namespace collisions.
- **Rpc** — typed request/response between addons, with timeouts and a typed client.
- **State** — replicated last-write-wins key/value, scoped to your namespace.

```ts
import { createSync } from '@bedrock-core/sync';

const sync = createSync({ id: 'myaddon', version: '1.0.0' });
sync.start();

sync.discovery.onPeerUp(peer => console.warn('peer up', peer.id));
sync.rpc.onRequest('ping', () => 'pong');
sync.state.set('myaddon', 'volume', 5);
```

No engine abstraction and no persistence — addons persist their own data.
