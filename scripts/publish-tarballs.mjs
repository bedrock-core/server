#!/usr/bin/env node
// Publish every public workspace as a yarn-packed tarball through the npm CLI.
//
//   - `yarn pack` rewrites the workspace: protocols into concrete versions —
//     `npm publish` from a workspace directory would ship `workspace:*` verbatim
//     and every consumer install would fail.
//   - `npm publish` (>= 11.5.1) performs the OIDC trusted-publishing exchange in
//     CI, so releases need no npm token.
//     Locally it falls back to your npm login and prompts for the 2FA code.
//
// A version that is already on the registry is skipped, so re-running after a
// partial release is safe.
//
// `0.0.0` is the placeholder a package that has never shipped sits at, and it is
// skipped until its release version has been assigned.
//
// Usage: node scripts/publish-tarballs.mjs [excluded-package-name ...]
//        node scripts/publish-tarballs.mjs --only <package-name>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);

if (args[0] === '--only' ? args.length !== 2 || args[1].startsWith('-') : args.some(arg => arg.startsWith('-'))) {
	throw new Error('Usage: publish-tarballs.mjs [excluded-package-name ...] | --only <package-name>');
}

const only = args[0] === '--only' ? args[1] : undefined;
const exclude = new Set(only === undefined ? args : []);
const shell = process.platform === 'win32';

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: 'utf-8', shell, ...opts });
}

// ── Workspaces, dependency-ordered ────────────────────────────────────────────
// `-v` includes each workspace's workspaceDependencies, which is all a
// topological sort needs: publish dependencies before dependents so a resolver
// that sees the dependent can already see what it requires.
const rows = run('yarn', ['workspaces', 'list', '--json', '-v'])
	.trim().split('\n').map(line => JSON.parse(line));

for (const name of only === undefined ? exclude : [only]) {
	if (!rows.some(row => row.name === name)) { throw new Error(`Unknown workspace: ${name}`); }
}

const byLocation = new Map(rows.map(row => [row.location, row]));
const pending = rows.filter((row) => {
	const manifest = JSON.parse(readFileSync(join(row.location, 'package.json'), 'utf-8'));

	if (only === row.name && manifest.private === true) { throw new Error(`Cannot publish private workspace: ${only}`); }

	return manifest.private !== true && (only === undefined ? !exclude.has(row.name) : row.name === only);
});

const ordered = [];
const seen = new Set();
function visit(row) {
	if (seen.has(row.location)) return;
	seen.add(row.location);
	for (const dep of row.workspaceDependencies ?? []) {
		const depRow = byLocation.get(dep);
		if (depRow) visit(depRow);
	}
	if (pending.includes(row)) ordered.push(row);
}
pending.forEach(visit);

// ── Pack with yarn, publish with npm ──────────────────────────────────────────
const outDir = mkdtempSync(join(tmpdir(), 'bcore-publish-'));
let published = 0;

for (const row of ordered) {
	const { name } = row;
	const { version } = JSON.parse(readFileSync(join(row.location, 'package.json'), 'utf-8'));

	if (version === '0.0.0') {
		console.log(`skip    ${name}@${version} — unreleased placeholder; set its version to publish it`);
		continue;
	}

	let exists = false;
	try {
		run('npm', ['view', `${name}@${version}`, 'version', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
		exists = true;
	} catch (error) {
		const missing = [error.stdout, error.stderr].some(output => {
			try { return JSON.parse(String(output)).error?.code === 'E404'; } catch { return false; }
		});

		if (!missing) { throw error; }
	}

	if (exists) {
		console.log(`skip    ${name}@${version} — already published`);
		continue;
	}

	const tarball = join(outDir, `${name.replace(/[@/]/g, '_')}.tgz`);
	run('yarn', ['workspace', name, 'pack', '--out', tarball], { stdio: 'inherit' });
	run('npm', ['publish', tarball], { stdio: 'inherit' });
	console.log(`publish ${name}@${version}`);
	published++;
}

console.log(`${published} published, ${ordered.length - published} skipped`);
