/**
 * `@bedrock-core/server/db` — persisted documents on dynamic properties.
 *
 * Re-exports `@bedrock-core/db`. An addon rarely needs this subpath: `core.db` is already an
 * instance keyed under the addon's namespace, and the runtime re-exports what a collection is
 * declared with (`schema`, the acceptors and combinators, the errors). Reach here for the rest —
 * the resolver, the host and capability types, the index.
 */
export * from '@bedrock-core/db';
