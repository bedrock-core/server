# @bedrock-core/server

![@bedrock-core](./assets/logo/title.png)

> ⚠️ Beta Status: Active development. Breaking changes may occur until 1.0.0. Pin exact versions for stability.


A modular collection of TypeScript packages for Minecraft Bedrock addon development, built for cross-addon compatibility. Every addon runs in its own isolated script realm — bedrock-core lets addons from different creators find each other and share data.

Full documentation & guides: https://bedrock-core.drav.dev/

---

## ✨ Features

- **Addon discovery** — addons announce their identity, version and dependencies, and enumerate their peers at runtime.
- **Replicated state** — shared last-write-wins key/value, scoped to your namespace.
- **Typed RPC** — typed request/response calls between addons, with timeouts.
- **Features** — enable or disable behaviour based on which peers are present.
- **Configuration** — server / dimension / player scopes, with typed accessors and live change subscriptions.
- **Guides** — compiled in-game guides, declared when the addon registers.

## 📦 Packages

- **`@bedrock-core/server`** — the meta package: one install for the whole stack. Re-exports the runtime at the root and the transport at `/sync`.
- **`@bedrock-core/server-runtime`** — the framework runtime: registration, the cross-addon registry, features, config and guides. Built on `sync`.
- **`@bedrock-core/sync`** — the low-level transport: message bus, discovery, RPC and replicated state over script events.

## 🤝 Contributing

Let's talk in Discord: <https://bedrock-core.drav.dev/discord>

## 📄 License

MIT
