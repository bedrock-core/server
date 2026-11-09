import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'bench/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', ['lcov', { projectRoot: fileURLToPath(new URL('../../', import.meta.url)) }]],
    },
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
  },
});
