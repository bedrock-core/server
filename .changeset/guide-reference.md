---
"@bedrock-core/server-runtime": minor
---

Publish a compiled guide as a reference the elected host presents with native forms.

An addon whose guide compiles into screens declares `guideReference` in `core.register()` —
`guideReference(ns)` from `@bedrock-core/guides`: per screen the compiled title, the baked entry
values and where each press leads, and nothing of what the guide says, since every client already
holds the screens in the pack. `GuidesRegistry.provideReference()` publishes it under the
`core-guide/reference` state key, `referenceOf()` reads a peer's, and `has()` counts a reference as a
guide. A host that finds one presents from it and renders nothing of the owning addon's; a manifest
keeps working for hosts that only render manifests.
