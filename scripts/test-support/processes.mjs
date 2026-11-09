import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const fixture = JSON.parse(fs.readFileSync(process.env.CORE_SCRIPT_FIXTURE, 'utf8'));

function record(command, args, options) {
  fs.appendFileSync(fixture.calls, JSON.stringify({ command, args, cwd: options?.cwd }) + '\n');
}

cp.execFileSync = (command, args, options) => {
  record(command, args, options);

  if (command === 'yarn' && args[0] === 'workspaces') { return fixture.rows.map(row => JSON.stringify(row)).join('\n') + '\n'; }

  if (command === 'npm' && args[0] === 'view') {
    if (fixture.lookup === 'exists') { return '"1.0.0"\n'; }

    const error = Object.assign(new Error(fixture.lookup), { status: 1, stdout: '', stderr: '' });

    if (fixture.lookup.startsWith('E')) {
      if (fixture.lookup === 'ETIMEDOUT') { error.code = fixture.lookup; }
      else { error[fixture.errorStream ?? 'stdout'] = JSON.stringify({ error: { code: fixture.lookup } }); }
    } else { error.stdout = fixture.lookup; }

    throw error;
  }

  if (command === 'yarn' && args[0] === 'workspace' && args[2] === 'pack') { return ''; }

  if (command === 'npm' && args[0] === 'publish') { return ''; }

  throw new Error(`Unexpected command: ${command}`);
};

syncBuiltinESMExports();
