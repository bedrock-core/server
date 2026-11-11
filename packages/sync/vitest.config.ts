import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/sync', import.meta.url)),
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'bench/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: fileURLToPath(new URL('../../coverage/sync', import.meta.url)),
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', ['lcov', { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) }]],
    },
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
  },
});
