# @bedrock-core/server

The meta package for the [bedrock-core](https://github.com/bedrock-core/server) server
stack. Install one dependency to get a matching, known-good set of the server packages.

```sh
yarn add @bedrock-core/server
```

## What you get

- **`@bedrock-core/server`** re-exports
  [`@bedrock-core/server-runtime`](https://github.com/bedrock-core/server/tree/main/packages/server-runtime#readme) —
  the framework runtime: addon registration, the cross-addon registry, features, config,
  guides and RPC. This is what most addons import.

  ```ts
  import { core } from '@bedrock-core/server';

  const config = core.register({
    creator: 'ms',
    creatorName: 'My Studio',
    pack: 'shop',
    packName: 'My Shop',
    version: '1.0.0',
  });
  ```

- **`@bedrock-core/server/sync`** re-exports
  [`@bedrock-core/sync`](https://github.com/bedrock-core/server/tree/main/packages/sync#readme) — the
  low-level cross-addon transport (message bus, peer discovery, RPC, replicated state)
  for when you need to talk to the transport layer directly.

  ```ts
  import { createSync } from '@bedrock-core/server/sync';
  ```

Each release pins the exact matching versions of the underlying packages, so upgrading
`@bedrock-core/server` moves the whole stack together.
