---
"@bedrock-core/sync": minor
---

A mirror applies an entry for a namespace only from the namespace's owner, unless the owner wrote
the key with `{ open: true }`; a foreign entry never sets or clears that flag, snapshots carry it,
and `droppedForeign` counts what was refused.
