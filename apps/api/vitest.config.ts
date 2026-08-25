import { defineConfig } from 'vitest/config';
import { testEnv } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    // Isolated from the dev stack: see vitest.shared.ts.
    env: testEnv,
    globalSetup: '../../packages/db/testing/globalSetup.ts',
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts', 'src/migrateCli.ts', 'src/index.ts', 'src/routes/deps.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
