import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: './e2e/setup.global.ts',
  outputDir: './e2e/artifacts/test-results',
  // next dev compiles routes on first hit — allow for that in assertions.
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:3005',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:3005',
    reuseExistingServer: true,
    timeout: 180_000,
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3100' },
  },
});
