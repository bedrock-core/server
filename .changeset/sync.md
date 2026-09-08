---
"@bedrock-core/sync": minor
---

**Owner-only state.** A mirror applies an entry for a namespace only from the namespace's owner —
the sending node for a delta, the recorded writer for a snapshot entry, so a snapshot relayed by a
third party still names the original writer. Anything else is dropped and counted in
`droppedForeign`. The rule holds for a node's own writes too, so a foreign write is visible locally
exactly when it is visible everywhere, which is never.

**`Events`, the subsystem for a happening.** `node.events.emit(name, payload)` broadcasts one
message; `on(namespace, name, handler)` subscribes to one sender's name. The namespace a handler
matches is the envelope's `src`, read from the transport rather than the payload, so a message
cannot claim to come from a node that did not send it. The sender dispatches to its own handlers
first, synchronously, before the message leaves; a handler that throws is caught and the others
still run. Nothing is stored and nothing is replayed.
