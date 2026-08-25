import { defineConfig } from 'vitest/config';
import { testEnv } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    // Isolated from the dev stack: see vitest.shared.ts.
    env: testEnv,
    globalSetup: '../../packages/db/testing/globalSetup.ts',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
