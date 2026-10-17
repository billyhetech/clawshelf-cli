import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // Each test file gets its own HOME; never share it between workers
    pool: 'forks',
  },
});
