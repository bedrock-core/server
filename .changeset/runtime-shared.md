---
"@bedrock-core/server-runtime": minor
---

Add `core.shared`: a `shared` shape declared in `register()` comes back as a typed tree whose nodes
carry `get` / `set` / `patch` / `subscribe`, with `open()`, `persisted()` and `leaf()` markers;
peers read it through `core.shared.of<Def>(ns)` from the announced shape, writing only opened
leaves; persisted leaves are kept on the world and restored a tick after registration.
`core.state` is deprecated in favour of the tree.
