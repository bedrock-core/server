---
"@bedrock-core/server-runtime": minor
---

Publish an addon's page in the shared addon list as a reference the elected host draws from.

An addon whose list page compiles into its pack declares `page` in `core.register()` —
`addonPageReference(Page)` from `@bedrock-core/config/compiled`: per reserved entry the value it is
shown with and where a press leads, and nothing of what the page shows, since every client already
holds the screen in the pack. `core.pages.provide()` publishes it under the `core-addon/page` state
key and `core.pages.of()` reads a peer's; a host that finds one writes the addon's marker and the
values into the list's reserved entries and the client draws the page over the list.
