import { spawn } from 'child_process';

// Watches both test addons. nodemon (see nodemon.json) re-runs this script when the shared
// library sources change, which restarts the regolith watches so the addons re-bundle.
// `yarn install` runs once in the root `watch` script (not here), so it never races — running
// it inside each addon's watch concurrently made two installs mutate the shared node_modules
// at the same time (EPERM unlink races).
//
// The second regolith watch is staggered so the two initial builds don't hit the com.mojang
// export at the same instant. Tune with WATCH_STAGGER_MS.
const STAGGER_MS = Number(process.env.WATCH_STAGGER_MS ?? 500);

const ADDONS = [
  '@bedrock-core/server-test-addon',
  '@bedrock-core/server-test-addon-2',
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

ADDONS.forEach((workspace, index) => {
  timers.push(setTimeout(() => {
    if (stopping) return;
    console.log(`▶️  regolith watch: ${workspace}`);
    children.push(spawn('yarn', ['workspace', workspace, 'run', 'watch'], { stdio: 'inherit', shell: true }));
  }, index * STAGGER_MS));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killAll();
    process.exit(0);
  });
}
