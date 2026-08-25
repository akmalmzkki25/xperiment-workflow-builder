import { spawnSync } from 'node:child_process';
import { startStack } from './services';

/**
 * Spawned rather than imported: Playwright transpiles this file to CommonJS, and
 * `@xperiment/db` is ESM that uses `import.meta.url`, which does not survive that. The services
 * migrate the database themselves at boot but cannot create it, so this has to happen
 * first, and it has to be the same implementation the vitest suites use.
 */
function ensureTestDatabase(): void {
  const run = spawnSync('pnpm', ['--filter', '@xperiment/db', 'run', 'ensure-test-db'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (run.status !== 0) {
    throw new Error('could not create the test database — is Postgres running? (docker compose up -d)');
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  ensureTestDatabase();
  const stack = await startStack();
  return async () => {
    await stack.stop();
  };
}
