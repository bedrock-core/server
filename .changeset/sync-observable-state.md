---
'@bedrock-core/sync': minor
---

Store replicated values in shared observables so keyed reads, subscriptions and snapshots use the same state. Preserve observable handles across deletions and peer departure, and copy published values and local event payloads using ordinary JSON semantics. Expose snapshot copy and freeze helpers through `/data`.

Track running peer instances in discovery, invalidate departed instances' snapshots and pending calls, and reject stale-instance traffic. Match RPC responses to their target and optional running instance, clean up request timers, and return handler or serialization failures as RPC errors. Discovery and state notifications isolate listener failures through standard signals.
