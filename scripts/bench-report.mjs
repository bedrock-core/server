/**
 * Turns a `bc-bds run --tag bench` transcript into tables.
 *
 * The runner's own report is a verdict per test, which is the right shape for a suite that is
 * red or green and the wrong shape for one that produces numbers. The benchmarks print their
 * results as `BENCH {json}` lines instead, and the server console carries script output verbatim,
 * so the transcript the runner already writes is the data channel — no second mechanism, and the
 * numbers stay next to the log lines that produced them.
 *
 * Usage:
 *   node scripts/bench-report.mjs [path/to/log]
 *
 * With no argument it reads the newest `bench` transcript under the runner's log directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Matches the marker anywhere in a line, since the engine prefixes script output with its own tags. */
const BENCH_LINE = /BENCH (\{.*\})\s*$/;

function logsDir() {
  return process.env.BC_BDS_HOME
    ? path.resolve(process.env.BC_BDS_HOME, 'logs')
    : path.join(repoRoot, '.bds', 'logs');
}

function newestBenchLog() {
  const dir = logsDir();

  if (!fs.existsSync(dir)) { return undefined; }

  const candidates = fs.readdirSync(dir)
    .filter(name => name.endsWith('-bench.log'))
    .map(name => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return candidates[0];
}

function parse(transcript) {
  const results = [];

  for (const line of transcript.split(/\r?\n/)) {
    const match = BENCH_LINE.exec(line);

    if (!match) { continue; }

    try {
      results.push(JSON.parse(match[1]));
    } catch {
      process.stderr.write(`skipping unparseable BENCH line: ${line}\n`);
    }
  }

  return results;
}

/** Group by the `name` each benchmark reports under, preserving first-seen order. */
function groupByName(results) {
  const groups = new Map();

  for (const { name, ...row } of results) {
    if (!groups.has(name)) { groups.set(name, []); }

    groups.get(name).push(row);
  }

  return groups;
}

const logFile = process.argv[2] ?? newestBenchLog();

if (!logFile) {
  process.stderr.write(`no bench transcript found in ${logsDir()} — run \`yarn test:mc:bench\` first\n`);
  process.exit(2);
}

if (!fs.existsSync(logFile)) {
  process.stderr.write(`no such transcript: ${logFile}\n`);
  process.exit(2);
}

const results = parse(fs.readFileSync(logFile, 'utf8'));

if (results.length === 0) {
  process.stderr.write(`no BENCH lines in ${logFile}\n`);
  process.stderr.write('the suite may have failed before reporting — check the transcript\n');
  process.exit(1);
}

process.stdout.write(`${path.relative(repoRoot, logFile)}\n`);

for (const [name, rows] of groupByName(results)) {
  process.stdout.write(`\n${name}\n`);
  console.table(rows);
}
