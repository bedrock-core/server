import { spawn } from 'child_process';

let child;

function startTestAddon() {
  if (child) {
    console.log('🔁 Restarting test-addon watch...');
    child.kill();
  }

  child = spawn('yarn', ['workspace', '@bedrock-core/server-test-addon', 'run', 'watch'], {
    stdio: 'inherit',
    shell: true,
  });
}

startTestAddon();

// graceful exit
process.on('SIGINT', () => {
  if (child) child.kill();
  process.exit();
});
