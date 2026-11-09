---
'@bedrock-core/sync': patch
---

Validate RPC error response fields before settling pending requests. Malformed replies leave the request available for a valid response or its timeout.
