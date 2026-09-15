#!/usr/bin/env node
/**
 * Version the root `@bedrock-core/server` package.
 *
 * Changesets only manages the `packages/*` workspaces — the repo root, which is the meta package
 * itself, is invisible to it — so the meta's version is set here, immediately after
 * `changeset version`.
 *
 * The rule: **the meta's version IS `@bedrock-core/server-runtime`'s**, character for character,
 * prerelease tag included. The runtime is what the meta is; `db`, `observable` and `sync` are
 * support around it. So `@bedrock-core/server@0.2.0` is `@bedrock-core/server-runtime@0.2.0`, and
 * a consumer reading either number is reading the same one.
 *
 * A release the runtime does not move leaves the meta where it is: what shipped was a package the
 * meta curates, and the curated set is republished with the runtime that next moves.
 *
 * The `workspace:*` dependency ranges are left untouched; `publish-tarballs.mjs` resolves them to
 * concrete versions at pack time.
 *
 * Idempotent: re-running with the meta already on the runtime's version is a no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const META_PATH = 'package.json';
const META_CHANGELOG = 'CHANGELOG.md';

/** The package whose version the meta's version *is*. */
const RUNTIME_PATH = 'packages/server-runtime/package.json';

/** Everything the meta curates, in `packages/<dir>` form — what its changelog entry lists. */
const META_DEP_DIRS = ['db', 'observable', 'server-runtime', 'sync'];

/** Matches the manifest's version field, capturing the quoted value so only it is replaced. */
const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/;

const currentVersion = (path) => JSON.parse(readFileSync(path, 'utf8')).version;
const nameOf = (path) => JSON.parse(readFileSync(path, 'utf8')).name;

const written = currentVersion(META_PATH);
const next = currentVersion(RUNTIME_PATH);

if (next === written) {
	console.log(`sync-meta-version: @bedrock-core/server already ${written} — no change.`);
	process.exit(0);
}

const manifest = readFileSync(META_PATH, 'utf8');

if (!VERSION_FIELD.test(manifest)) {
	throw new Error(`sync-meta-version: could not find the version field in ${META_PATH}`);
}

// Tabs — this manifest is tab-indented; a targeted replace preserves that.
writeFileSync(META_PATH, manifest.replace(VERSION_FIELD, `$1${next}$3`));
console.log(`sync-meta-version: @bedrock-core/server ${written} → ${next}, matching @bedrock-core/server-runtime.`);

// The meta's changelog is what it curates, so write the entry `changeset version` cannot.
const pinned = META_DEP_DIRS
	.map(dir => `  - ${nameOf(`packages/${dir}/package.json`)}@${currentVersion(`packages/${dir}/package.json`)}`)
	.join('\n');
const entry = `## ${next}\n\n### Patch Changes\n\n- Curates:\n\n${pinned}\n\n`;
const changelog = readFileSync(META_CHANGELOG, 'utf8');
const firstEntry = changelog.indexOf('## ');

writeFileSync(
	META_CHANGELOG,
	firstEntry === -1 ? `${changelog.trimEnd()}\n\n${entry}` : changelog.slice(0, firstEntry) + entry + changelog.slice(firstEntry),
);
console.log(`sync-meta-version: ${META_CHANGELOG} entry for ${next}`);
