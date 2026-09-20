---
"@bedrock-core/server-runtime": minor
---

**Breaking.** Guides left the runtime: the `guide` and `guideReference` options of `register()`, `core.guides`, `core.guides.manifest`, `GuidesRegistry`, `GuideReference` and `GuideManifest` are removed. A guide is a set of compiled screens from `@bedrock-core/guides`, reached by navigating to its key, and the screens an addon publishes are read through `screens(core)` from `@bedrock-core/navigation`.
