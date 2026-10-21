import { spawn } from 'child_process';

// Watches both test packs. nodemon (see nodemon.json) re-runs this script when the shared
// library sources change, which restarts the builder watches so the packs re-bundle.
// Install dependencies once in the root watch script before starting either build.
// WATCH_STAGGER_MS controls the delay between the initial builds.
const STAGGER_MS = Number(process.env.WATCH_STAGGER_MS ?? 1000);

const PACKS = [
  'watch',
  'watch:peer',
];

const children = [];
const timers = [];
let stopping = false;

function killAll() {
  stopping = true;
  for (const timer of timers.splice(0)) clearTimeout(timer);

  for (const child of children.splice(0)) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

PACKS.forEach((script, index) => {
  timers.push(setTimeout(() => {
    if (stopping) return;
    console.log(`▶️  builder ${script}`);
    children.push(spawn('yarn', ['workspace', '@bedrock-core/server-test-fixtures', 'run', script], { stdio: 'inherit', shell: true }));
  }, index * STAGGER_MS));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killAll();
    process.exit(0);
  });
}
