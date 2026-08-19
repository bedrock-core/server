# @bedrock-core/sync

## 0.1.0

### Minor Changes

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

- [`b69851f`](https://github.com/bedrock-core/server/commit/b69851fe6ba452c899e2869adec03655c2bb404f) Thanks [@drav0011](https://github.com/drav0011)! - Initial release.

  The low-level cross-addon transport. Every addon runs in its own isolated script realm; `sync` layers four things on top of script events so they can reach each other:

  - **Bus** — the script-event message bus, with envelopes and chunked sends.
  - **Discovery** — peers announce identity and version, and report namespace collisions.
  - **Rpc** — typed request/response between addons, with timeouts and a typed client.
  - **State** — replicated last-write-wins key/value, scoped to your namespace.

  ```ts
  import { createSync } from "@bedrock-core/sync";

  const sync = createSync({ id: "myaddon", version: "1.0.0" });
  sync.start();

  sync.discovery.onPeerUp((peer) => console.warn("peer up", peer.id));
  sync.rpc.onRequest("ping", () => "pong");
  sync.state.set("myaddon", "volume", 5);
  ```

  No engine abstraction and no persistence — addons persist their own data.
