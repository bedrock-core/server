#!/usr/bin/env node
/**
 * Regenerate `RUNTIME_VERSION` from `@bedrock-core/server-runtime`'s package.json.
 *
 * Runs right after `changeset version` (see the root `version-packages` script), so the
 * constant is rewritten inside the Version PR and can never disagree with the tag that
 * ships it. `@bedrock-core/config` renders this version in its addon list and the host
 * election compares it across realms, so drift would be visible in-game.
 *
 * Idempotent: re-running with no version change rewrites the same bytes and prints a no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PKG_PATH = 'packages/server-runtime/package.json';
const TARGET_PATH = 'packages/server-runtime/src/runtime-version.ts';

/** Matches the generated export, capturing the quoted version so only it is replaced. */
const VERSION_EXPORT = /(export const RUNTIME_VERSION = ')([^']*)(';)/;

const version = JSON.parse(readFileSync(PKG_PATH, 'utf8')).version;

if (typeof version !== 'string' || version.length === 0) {
	throw new Error(`sync-runtime-version: no version field in ${PKG_PATH}`);
}

const source = readFileSync(TARGET_PATH, 'utf8');
const match = VERSION_EXPORT.exec(source);

if (!match) {
	throw new Error(
		`sync-runtime-version: could not find the RUNTIME_VERSION export in ${TARGET_PATH}. `
		+ 'If it was renamed or reformatted, update VERSION_EXPORT in this script.',
	);
}

const previous = match[2];

if (previous === version) {
	console.log(`sync-runtime-version: RUNTIME_VERSION already ${version} — no change.`);
	process.exit(0);
}

writeFileSync(TARGET_PATH, source.replace(VERSION_EXPORT, `$1${version}$3`));
console.log(`sync-runtime-version: RUNTIME_VERSION ${previous} → ${version}`);
