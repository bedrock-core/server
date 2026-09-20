#!/usr/bin/env node
/**
 * Push the workspace-root meta package tag and create its GitHub release.
 *
 * Changesets Action v2 intentionally maps child workspaces, not the package at
 * the workspace root. tag-packages.mjs therefore reports only child packages
 * to the action and leaves the root tag/release to this rerunnable script.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `${manifest.name}@${manifest.version}`;
const tagRef = `refs/tags/${tag}`;

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function succeeds(command, args) {
	try {
		run(command, args, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function releaseNotes(changelog, version) {
	const header = new RegExp(`^## ${escapeRegExp(version)}\\s*$`, 'm');
	const match = header.exec(changelog);
	if (!match) throw new Error(`CHANGELOG.md has no entry for ${version}`);

	const remainder = changelog.slice(match.index + match[0].length).replace(/^\r?\n/, '');
	const nextHeader = remainder.search(/^## /m);
	const notes = (nextHeader === -1 ? remainder : remainder.slice(0, nextHeader)).trim();
	if (!notes) throw new Error(`CHANGELOG.md entry for ${version} is empty`);
	return notes;
}

const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), manifest.version);

const remoteTagExists = succeeds('git', ['ls-remote', '--exit-code', '--tags', 'origin', tagRef]);
if (remoteTagExists) {
	console.log(`tag     ${tag} - already pushed`);
} else if (dryRun) {
	console.log(`tag     ${tag} - would push`);
} else {
	if (!succeeds('git', ['rev-parse', '--verify', tagRef])) {
		run('git', ['tag', tag], { stdio: 'inherit' });
	}
	run('git', ['push', 'origin', tagRef], { stdio: 'inherit' });
	console.log(`tag     ${tag} - pushed`);
}

const githubReleaseExists = succeeds('gh', ['release', 'view', tag]);
if (githubReleaseExists) {
	console.log(`release ${tag} - already exists`);
} else if (dryRun) {
	console.log(`release ${tag} - would create`);
} else {
	if (!succeeds('git', ['ls-remote', '--exit-code', '--tags', 'origin', tagRef])) {
		throw new Error(`Cannot create release before ${tagRef} exists on origin`);
	}
	run('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--notes', notes], {
		stdio: 'inherit',
	});
	console.log(`release ${tag} - created`);
}
