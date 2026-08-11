import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Only the pure modules. `main.ts` is a top-level script that spawns six
      // long-running processes, and `supervisor.ts` is thin wrappers over spawn and
      // taskkill — mocking either would test the mock, not the behaviour. They are
      // exercised by actually running `pnpm dev`.
      include: ['src/env.ts', 'src/services.ts', 'src/preflight.ts'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
