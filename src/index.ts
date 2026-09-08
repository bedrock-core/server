/**
 * `@bedrock-core/server` — the meta package for the bedrock-core server stack.
 *
 * A single dependency that curates the matching versions of the server packages and
 * re-exports the framework runtime. Most addons only need:
 *
 * ```ts
 * import { core } from '@bedrock-core/server';
 *
 * const config = core.register({ manifest: { creator: 'ms', pack: 'shop', packName: 'My Shop', version: '1.0.0' } });
 * ```
 *
 * The packages the runtime is built on are each at their own subpath, for when you reach
 * past `core` to the thing itself:
 *
 * - `@bedrock-core/server/sync` — the transport: bus, discovery, RPC, replicated state.
 * - `@bedrock-core/server/db` — persisted documents. `core.db` is one of these already, and
 *   the runtime re-exports what a collection is *declared* with, so this subpath is for the
 *   rest of the surface.
 * - `@bedrock-core/server/observable` — the reactive primitive every accessor in the stack is,
 *   `toNative` included: the bridge to a data-driven form's own observables.
 */
export * from '@bedrock-core/server-runtime';
