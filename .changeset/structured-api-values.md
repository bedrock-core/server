---
'@bedrock-core/sync': major
'@bedrock-core/server-runtime': minor
---

Preserve structured application values across API calls, replicated state and signals: collections, sparse arrays, exact numeric values, big integers, dates, regular expressions and binary views. Retain cycles and aliases within each message, including object keys in maps. Guard collection snapshots against mutation and retain native-reference and custom-codec handling inside collections. Structured payloads use protocol 3; plain JSON traffic remains compatible with earlier protocols.

Expose named snapshot replication through SyncNode.replication. Publishers broadcast immutable replacements and withdrawals; explicit watches retain remote values and request one current snapshot when opened. Sync owns replication startup, shutdown and peer-instance invalidation. Server Runtime uses this transport for registry datasets while owning their schemas and provider selection.
