/**
 * `@bedrock-core/server` — the meta package for the bedrock-core server stack.
 *
 * A single dependency that curates the matching versions of the server packages and
 * re-exports the framework runtime. Most addons only need:
 *
 * ```ts
 * import { core } from '@bedrock-core/server';
 *
 * const config = core.register({ creator: 'my_studio', namespace: 'bc_shop', name: 'My Shop', version: '1.0.0' });
 * ```
 *
 * The lower-level transport (bus, discovery, RPC, replicated state) is available at
 * the `@bedrock-core/server/sync` subpath when you need it directly rather than
 * through the runtime.
 */
export * from '@bedrock-core/server-runtime';
