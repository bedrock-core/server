import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/i18n', import.meta.url)),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: { reportsDirectory: fileURLToPath(new URL('../../coverage/i18n', import.meta.url)) },
  },
});
