import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = pathToFileURL(path.join(repoRoot, 'scripts/test-support/processes.mjs')).href;

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const base = fs.mkdtempSync(path.join(parent, 'bedrock-core-script-test-'));
  const root = path.join(base, 'project with spaces [test]');

  fs.mkdirSync(root);
  t.after(() => {
    const target = fs.realpathSync(base);
    const relative = path.relative(parent, target);

    assert(!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('bedrock-core-script-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });

  return root;
}

function write(root, file, value = 'generated') {
  const target = path.join(root, file);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));

  return target;
}

function run(script, { cwd = repoRoot, args = [], env = {}, mocked = false } = {}) {
  return spawnSync(process.execPath, [...(mocked ? ['--import', preload] : []), script, ...args], {
    cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env },
  });
}

test('cleanup removes regenerated files throughout the project without following external links', t => {
  const root = temporary(t);
  const outside = temporary(t);

  write(root, 'scripts/clean.mjs', fs.readFileSync(path.join(repoRoot, 'scripts/clean.mjs'), 'utf8'));
  const removed = ['node_modules/cache.txt', 'packages/a/dist/output.js', 'packages/test-fixtures/main/build/output.js',
    'packages/a/coverage/report.json', '.cache/temporary.txt', '.bedrock-core/report.json',
    '.bds/cache/archive.zip', '.bds/schema/bds-runner.json', '.bds/server/1.2.3/bedrock_server.exe', '.bds/logs/test.log'];
  const preserved = ['src/source.ts', 'package.json', '.github/workflows/ci.yml', '.git/objects/build/metadata'];

  for (const file of [...removed, ...preserved]) { write(root, file); }

  const external = write(outside, 'build/source.txt', 'external source');

  fs.symlinkSync(outside, path.join(root, 'external'), 'junction');
  const result = run('scripts/clean.mjs', { cwd: root });

  assert.equal(result.status, 0, result.stderr);

  for (const file of removed) { assert(!fs.existsSync(path.join(root, file)), file); }

  for (const file of preserved) { assert(fs.existsSync(path.join(root, file)), file); }

  assert(!fs.existsSync(path.join(root, '.bds')));
  assert.equal(fs.readFileSync(external, 'utf8'), 'external source');
});

function publisher(t, { lookup = 'E404', args = [], privateDependency = false, errorStream } = {}) {
  const root = temporary(t);
  const calls = path.join(root, 'calls.jsonl');
  const data = write(root, 'fixture.json', { lookup, errorStream, calls, rows: [
    { name: '@fixture/root', location: '.', workspaceDependencies: ['packages/dep'] },
    { name: '@fixture/dep', location: 'packages/dep', workspaceDependencies: [] },
  ] });

  write(root, 'package.json', { name: '@fixture/root', version: '1.0.0' });
  write(root, 'packages/dep/package.json', { name: '@fixture/dep', version: '1.0.0', private: privateDependency });
  const result = run(path.join(repoRoot, 'scripts/publish-tarballs.mjs'), { cwd: root, args, mocked: true,
    env: { CORE_SCRIPT_FIXTURE: data, TEMP: root, TMP: root } });
  const records = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

  return { result, records };
}

for (const lookup of ['E401', 'E403', 'ETIMEDOUT', 'invalid JSON', '{"error":{"code":"E500"}}']) {
  test('publisher stops on registry failure ' + lookup, t => {
    const { result, records } = publisher(t, { lookup });

    assert.notEqual(result.status, 0);
    assert(!records.some(call => call.args[0] === 'publish' || call.args[2] === 'pack'));
  });
}

for (const errorStream of ['stdout', 'stderr']) {
  test('publisher accepts a confirmed E404 from ' + errorStream + ' and publishes dependencies first', t => {
    const { result, records } = publisher(t, { errorStream });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(records.filter(call => call.args[2] === 'pack').map(call => call.args[1]), ['@fixture/dep', '@fixture/root']);
    assert.equal(records.filter(call => call.command === 'npm' && call.args[0] === 'publish').length, 2);
    assert(records.filter(call => call.args[0] === 'view').every(call => call.args.includes('--json')));
  });
}

test('publisher skips existing versions and keeps --only scoped to one public workspace', t => {
  const existing = publisher(t, { lookup: 'exists' });

  assert.equal(existing.result.status, 0, existing.result.stderr);
  assert(!existing.records.some(call => call.args[0] === 'publish' || call.args[2] === 'pack'));
  const selected = publisher(t, { args: ['--only', '@fixture/root'] });

  assert.equal(selected.result.status, 0, selected.result.stderr);
  assert.deepEqual(selected.records.filter(call => call.args[2] === 'pack').map(call => call.args[1]), ['@fixture/root']);
});

for (const args of [['--only'], ['--only', '@fixture/missing'], ['--only', '@fixture/root', 'extra'], ['@fixture/missing']]) {
  test('publisher rejects invalid selection ' + args.join(' '), t => {
    const { result, records } = publisher(t, { args });

    assert.notEqual(result.status, 0);
    assert(!records.some(call => call.command === 'npm' || call.args[2] === 'pack'));
  });
}

test('publisher refuses a private --only selection', t => {
  const { result, records } = publisher(t, { privateDependency: true, args: ['--only', '@fixture/dep'] });

  assert.notEqual(result.status, 0);
  assert(result.stderr.includes('private workspace'));
  assert(!records.some(call => call.command === 'npm'));
});

test('benchmark reports use the default runner home and accept an override or explicit transcript', t => {
  const root = temporary(t);

  write(root, 'scripts/bench-report.mjs', fs.readFileSync(path.join(repoRoot, 'scripts/bench-report.mjs'), 'utf8'));

  write(root, '.bds/logs/current-bench.log', 'BENCH {"name":"current-home","p50":1}\n');
  const normal = run('scripts/bench-report.mjs', { cwd: root, env: { BC_BDS_HOME: '' } });

  assert.equal(normal.status, 0, normal.stderr);
  assert(normal.stdout.includes('current-home'));
  const override = write(root, 'custom/logs/custom-bench.log', 'BENCH {"name":"custom-home","p50":2}\n');
  const custom = run('scripts/bench-report.mjs', { cwd: root, env: { BC_BDS_HOME: 'custom' } });

  assert.equal(custom.status, 0, custom.stderr);
  assert(custom.stdout.includes('custom-home'));
  const explicit = run('scripts/bench-report.mjs', { cwd: root, args: [override], env: { BC_BDS_HOME: '' } });

  assert.equal(explicit.status, 0, explicit.stderr);
  assert(explicit.stdout.includes('custom-home'));
});
