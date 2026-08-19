# @bedrock-core/server

## 0.1.0

### Minor Changes

- [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f) Thanks [@drav0011](https://github.com/drav0011)! - Initial release.

  The meta package: one install that curates matching versions of the server stack. It re-exports the runtime at the root, and the transport at the `/sync` subpath for when you need the bus, discovery, RPC or replicated state directly.

  ```ts
  import { core } from "@bedrock-core/server";

  const config = core.register({
    creator: "bt",
    pack: "gc_shop",
    packName: "My Shop",
    version: "1.0.0",
  });
  ```

  Most addons should depend on this rather than on `@bedrock-core/server-runtime` and `@bedrock-core/sync` separately.

### Patch Changes

- Updated dependencies [[`6b7f519`](https://github.com/bedrock-core/server/commit/6b7f519dc142a305de07516c34814fb972a875cb), [`36322bb`](https://github.com/bedrock-core/server/commit/36322bb53d4da391170686f124b78c4144d49bf9), [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f), [`f45e781`](https://github.com/bedrock-core/server/commit/f45e7812d01bf48d0a8e8bece077f2bb44de9f31), [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f)]:
  - @bedrock-core/server-runtime@0.1.0
  - @bedrock-core/sync@0.1.0
