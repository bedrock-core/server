#!/usr/bin/env node
/**
 * Version the root `@bedrock-core/server` package.
 *
 * Changesets only manages the `packages/*` workspaces — the repo root, which is
 * the meta package itself, is invisible to it — so the meta's version is derived
 * here, immediately after `changeset version`.
 *
 * The rule: **the meta's MAJOR.MINOR is `@bedrock-core/server-runtime`'s.** The
 * runtime is what the meta *is*; `sync` is support around it. So:
 *
 *   runtime line moved (0.1.x → 0.2.x, 0.x → 1.x) → meta jumps to <line>.0
 *   a curated package changed, at any level       → meta patch
 *   nothing changed                               → no-op
 *
 * A minor on `sync` is a *patch* to the meta: what ships is the meta's support
 * for that change, not a new framework line.
 *
 * The line only ever moves **forward**. npm can't unpublish, so a meta sitting
 * ahead of the runtime holds where it is, patching, until the runtime's line
 * catches up — from then on the two are pinned.
 *
 * The `workspace:*` dependency ranges are left untouched; `publish-tarballs.mjs`
 * resolves them to concrete versions at pack time.
 *
 * Idempotent: re-running with the meta already on the right version is a no-op.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const META_PATH = 'package.json';
const META_CHANGELOG = 'CHANGELOG.md';

/** The package whose MAJOR.MINOR the meta's version *is*. */
const RUNTIME_PATH = 'packages/server-runtime/package.json';

/** Everything the meta curates, in `packages/<dir>` form. */
const META_DEP_DIRS = ['server-runtime', 'sync'];

/** Matches the manifest's version field, capturing the quoted value so only it is replaced. */
const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/;

const readVersion = (json) => JSON.parse(json).version;
const currentVersion = (path) => readVersion(readFileSync(path, 'utf8'));
const nameOf = (path) => JSON.parse(readFileSync(path, 'utf8')).name;

/** Version of a package.json at git HEAD, or null if it isn't committed yet. */
function headVersion(path) {
	try {
		return readVersion(execSync(`git show HEAD:${path}`, { encoding: 'utf8' }));
	} catch {
		return null;
	}
}

/** `1.2.3` → `[1, 2, 3]`. */
function parse(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');

	if (!match) throw new Error(`sync-meta-version: cannot parse the version "${version}"`);

	return match.slice(1, 4).map(Number);
}

/** Is `a`'s MAJOR.MINOR strictly ahead of `b`'s? */
const lineAhead = (a, b) => (a[0] === b[0] ? a[1] > b[1] : a[0] > b[0]);

const written = currentVersion(META_PATH);
const meta = parse(written);
const runtime = parse(currentVersion(RUNTIME_PATH));

let next;

if (lineAhead(runtime, meta)) {
	next = `${runtime[0]}.${runtime[1]}.0`;
	console.log(`sync-meta-version: server-runtime line → ${runtime[0]}.${runtime[1]} — the meta follows it.`);
} else {
	// A package that isn't committed yet (headVersion null) is new, not changed.
	const changed = META_DEP_DIRS.filter((dir) => {
		const path = `packages/${dir}/package.json`;
		const head = headVersion(path);

		return head !== null && head !== currentVersion(path);
	});

	if (changed.length === 0) {
		console.log(`sync-meta-version: no @bedrock-core/server dependency changed (${written}) — nothing to pin.`);
		process.exit(0);
	}

	next = `${meta[0]}.${meta[1]}.${meta[2] + 1}`;
	console.log(`sync-meta-version: support for ${changed.join(', ')} — meta patch.`);
}

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
console.log(`sync-meta-version: @bedrock-core/server ${written} → ${next}`);

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
