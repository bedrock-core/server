---
'@bedrock-core/observable': major
---

Add `signal<T>()` for transient events with independent, idempotent cleanup and isolated listener failures. `Signal<T>` subscriptions return an unsubscribe function and expose no retained value or native filter options.

Describe callback-removal event sources with `NativeSignal<T, Options>` and adapt them through `toSignal()`, preserving native options and returned callback tokens. Export the adapter from the root and `/minecraft` entries. `last()` accepts both standard signals and native event sources.
