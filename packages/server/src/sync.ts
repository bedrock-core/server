/**
 * `@bedrock-core/server/sync` — the low-level cross-addon transport.
 *
 * Re-exports `@bedrock-core/sync` (message bus, peer discovery, RPC and replicated
 * state) for addons that talk to the transport layer directly instead of going
 * through the runtime exposed by the package root.
 */
export * from '@bedrock-core/sync';
