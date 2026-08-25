import { defineConfig } from 'vitest/config';
import { testEnv } from '../vitest.shared.js';

export default defineConfig({
  test: {
    // Isolated from the dev stack: see vitest.shared.ts. The five services this suite
    // spawns inherit process.env, so they land on the same database and Redis.
    env: testEnv,
    globalSetup: '../packages/db/testing/globalSetup.ts',
    testTimeout: 60000,
    hookTimeout: 90000,
  },
});
