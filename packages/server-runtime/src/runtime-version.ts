/**
 * The framework version, kept in lockstep with `packages/server-runtime/package.json`.
 *
 * GENERATED at release time by `scripts/sync-runtime-version.mjs`, which runs immediately
 * after `changeset version` inside the Version PR. Don't edit by hand — the next release
 * overwrites it.
 *
 * Two things read it, so drift is user-visible rather than cosmetic:
 * - `@bedrock-core/config` renders it as the synthetic bedrock-core entry in the addon list.
 * - {@link HostElection} elects the highest version present as the UI host.
 */
export const RUNTIME_VERSION = '0.1.0';
