---
"@bedrock-core/observable": minor
---

Add `debounce(source, schedule, options?)` for read-only values that publish the latest source change after a quiet period, with cancellation and disposal. Add `afterTicks(ticks)` to the `/minecraft` entry for reusable Minecraft tick scheduling, and declare `@minecraft/server` as an optional peer dependency. Both helpers are re-exported through `@bedrock-core/server/observable`.
