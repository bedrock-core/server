import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/server-runtime', import.meta.url)),
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    coverage: { reportsDirectory: fileURLToPath(new URL('../../coverage/server-runtime', import.meta.url)) },
  },
});
