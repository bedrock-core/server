---
'@bedrock-core/server-runtime': minor
'@bedrock-core/sync': minor
---

Every listener registration in the framework is `subscribe`. `onChange` is gone, with no alias.

**Breaking.** Config scopes were renamed to `subscribe` in this same release, to match `world.afterEvents.playerSpawn.subscribe(...)` — and then the rest of the stack still said `onChange`, so an addon subscribing to two things wrote the verb two ways for no reason a reader could name. One idiom now, top to bottom:

```ts
core.state.subscribe(({ key, value, deleted }) => { /* … */ });   // ScopedState
core.host.subscribe((hostId, previousHostId) => { /* … */ });     // HostElection
core.translations.subscribe(() => { /* … */ });                   // TranslationsRegistry
core.guides.subscribe(() => { /* … */ });                         // GuidesRegistry
core.node.state.subscribe(({ ns, key }) => { /* … */ });          // sync's State, unscoped
```

`sync`'s `State.onChange` moved with them, since the four runtime registrations above are what delegate to it — leaving the bottom of the stack on the old name would have made the persistence pattern in every README read against itself. Nothing else changed: the listener signatures, the filtering `ScopedState` does, the coarse payload-free `TranslationsRegistry` / `GuidesRegistry` notifications, and the `Unsubscribe` return are all as they were, so migrating is renaming the call.

`Registry` is deliberately untouched. `onRegister`, `onUnregister`, `onNamespaceCollision` and `onDependenciesSatisfied` have the same listener-in / unsubscribe-out shape, but they are four *distinct* events rather than one "something changed" channel — they cannot all be `subscribe`, and picking one to rename would be worse than leaving the set alone.
