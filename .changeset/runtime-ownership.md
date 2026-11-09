---
"@bedrock-core/server-runtime": minor
---

Keep database ownership in consuming libraries and addons. Expose AddonRegistry for addon discovery, use Sync replication for registry datasets, own translation integration under registries, and encapsulate API binding lifetimes in the API subsystem.

Return the owning Runtime from registration with inferred read-only declaration accessors. Keep the local manifest in AddonRegistry and coordinate publications and optional readers through the registry subsystem.
