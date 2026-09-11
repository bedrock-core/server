---
"@bedrock-core/server-runtime": minor
---

**Breaking.** `core.guides` is gone; `core.screens` replaces it.

A guide's pages are compiled screens like any other, so the feed that carried a guide is now the
feed that carries screens. An addon announces every static screen it compiled — per screen the
compiled title, the value each entry is shown with, and the key each press leads to — under
`core-ui/reference`:

```ts
import { uiReference } from '@bedrock-core/generated/ui';

core.register({ ..., screens: uiReference() });
```

`core.screens.of(ns)` reads one addon's table and `core.screens.find(key)` resolves a single key
from whichever addon published it, so `navigate('<addon>:<screen>')` works in a realm running none
of that addon's script — the layouts are in the pack every client already holds.

Removed with it: the `guide` and `guideReference` options of `register()`, `core.guides`,
`core.guides.manifest`, `GuidesRegistry`, `GuideReference` and `GuideManifest`. A guide is reached
by navigating to its index key, and gating a page per viewer is a carried `visible` on the compiled
screen rather than a manifest the host filters.
