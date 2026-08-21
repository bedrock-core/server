#!/usr/bin/env node
/**
 * Pin the `@bedrock-core/server` meta package to `@bedrock-core/server-runtime`.
 *
 * The rule: **the meta's MAJOR.MINOR is the runtime's.** The runtime is what the
 * meta *is*; `sync` and everything else it curates are support around it. So:
 *
 *   runtime line moved (0.1.x → 0.2.x, 0.x → 1.x) → meta jumps to <line>.0
 *   anything else changed, at any level           → meta patch
 *   nothing changed                               → no-op
 *
 * A minor on `sync`, or a changeset that asks the meta itself for a minor, is a
 * *patch* to the meta: what ships is the meta's support for that change, not a
 * new framework line. Left to itself changesets would get this wrong in both
 * directions — `updateInternalDependencies: patch` only ever patches the meta
 * when the runtime takes a minor, and an explicit meta changeset can move it
 * without the runtime moving at all.
 *
 * Runs inside `yarn version-packages`, right after `changeset version`, so it
 * corrects the version changesets just wrote (and retitles the changelog entry
 * that went with it) before anything is committed, tagged or published.
 *
 * The line only ever moves **forward**. npm can't unpublish, so a meta sitting
 * ahead of the runtime holds where it is, patching, until the runtime's line
 * catches up — from then on the two are pinned.
 *
 * Idempotent: re-running with the meta already on the right version is a no-op.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const META_PATH = 'packages/server/package.json';
const META_CHANGELOG = 'packages/server/CHANGELOG.md';
const RUNTIME_PATH = 'packages/server-runtime/package.json';

/** Matches the manifest's version field, capturing the quoted value so only it is replaced. */
const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/;

const readVersion = (json) => JSON.parse(json).version;
const currentVersion = (path) => readVersion(readFileSync(path, 'utf8'));

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

/** What changesets just wrote, and what was last released. */
const written = currentVersion(META_PATH);
const released = headVersion(META_PATH) ?? written;
const runtime = parse(currentVersion(RUNTIME_PATH));
const base = parse(released);

let next;

if (lineAhead(runtime, base)) {
	next = `${runtime[0]}.${runtime[1]}.0`;
	console.log(`sync-meta-version: server-runtime line → ${runtime[0]}.${runtime[1]} — the meta follows it.`);
} else if (written !== released) {
	next = `${base[0]}.${base[1]}.${base[2] + 1}`;
} else {
	console.log(`sync-meta-version: @bedrock-core/server unchanged (${written}) — nothing to pin.`);
	process.exit(0);
}

if (next === written) {
	console.log(`sync-meta-version: @bedrock-core/server already ${written} — no change.`);
	process.exit(0);
}

const manifest = readFileSync(META_PATH, 'utf8');

if (!VERSION_FIELD.test(manifest)) {
	throw new Error(`sync-meta-version: could not find the version field in ${META_PATH}`);
}

// Tabs — these manifests are tab-indented; a targeted replace preserves that.
writeFileSync(META_PATH, manifest.replace(VERSION_FIELD, `$1${next}$3`));
console.log(`sync-meta-version: @bedrock-core/server ${written} → ${next} (released ${released})`);

// Retitle the entry `changeset version` just wrote, so the changelog and the tag agree.
if (!existsSync(META_CHANGELOG)) process.exit(0);

const changelog = readFileSync(META_CHANGELOG, 'utf8');
const heading = new RegExp(`^## ${written.replace(/\./g, '\.')}$`, 'm');

if (!heading.test(changelog)) {
	console.warn(`sync-meta-version: no "## ${written}" heading in ${META_CHANGELOG} — retitle it by hand.`);
	process.exit(0);
}

writeFileSync(META_CHANGELOG, changelog.replace(heading, `## ${next}`));
console.log(`sync-meta-version: ${META_CHANGELOG} heading ${written} → ${next}`);
