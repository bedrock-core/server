---
'@bedrock-core/sync': patch
---

Retire a previously compatible peer when its replacement announces an incompatible protocol range. Clear its negotiated transport protocol and invalidate outstanding calls, state and publication snapshots owned by the departed instance.
