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
    baseURL: 'http://127.0.0.1:3105',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  // Its own port and its own build directory, deliberately. On 3005 this reused whatever
  // dev server happened to be running — one started by hand points at the real API on
  // :3000, so the suite silently tested the dev stack instead of the one it just spawned,
  // and wrote its registrations into the dev database. Sharing `.next` with that server
  // would corrupt it too. 3105 mirrors the 3100-3104 the backend services already use.
  webServer: {
    command: 'pnpm exec next dev -p 3105',
    url: 'http://127.0.0.1:3105',
    reuseExistingServer: true,
    timeout: 180_000,
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3100', NEXT_DIST_DIR: '.next-e2e' },
  },
});
