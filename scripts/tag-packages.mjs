#!/usr/bin/env node
/**
 * Tag every public package at its current version.
 *
 * Changesets Action reads JSONL events from CHANGESETS_OUTPUT when a custom
 * publish script is used. Reporting each new tag here lets the action push the
 * tags and create the corresponding GitHub releases, including the root meta
 * package that Changesets does not manage directly.
 *
 * Pass `--dry-run` to list missing tags without creating them.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const shell = process.platform === 'win32';
const dryRun = process.argv.includes('--dry-run');

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: 'utf8', shell, ...options });
}

const workspaces = run('yarn', ['workspaces', 'list', '--json'])
	.trim()
	.split('\n')
	.filter(Boolean)
	.map(line => JSON.parse(line));

for (const workspace of workspaces) {
	const manifest = JSON.parse(readFileSync(join(workspace.location, 'package.json'), 'utf8'));

	if (manifest.private === true || manifest.version === '0.0.0') continue;

	const tag = `${manifest.name}@${manifest.version}`;
	let exists = true;

	try {
		run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdio: 'ignore' });
	} catch {
		exists = false;
	}

	if (exists) {
		console.log(`tag     ${tag} - already exists`);
		continue;
	}
	if (dryRun) {
		console.log(`tag     ${tag} - would create`);
		continue;
	}

	run('git', ['tag', tag], { stdio: 'inherit' });
	console.log(`tag     ${tag}`);

	if (process.env.CHANGESETS_OUTPUT) {
		appendFileSync(
			process.env.CHANGESETS_OUTPUT,
			`${JSON.stringify({ type: 'git-tag', tag, packageName: manifest.name })}\n`,
		);
	}
}
