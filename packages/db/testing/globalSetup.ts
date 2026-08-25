import { ensureDatabaseExists } from '../src/ensureDatabase.js';
import { TEST_DATABASE_URL } from '../../../vitest.shared.js';

/**
 * Make sure the test database exists before any suite connects to it.
 *
 * Lives in `packages/db` rather than at the repo root so that `pg` and the repo's own
 * source resolve normally — pnpm's node_modules layout would not let a root-level file
 * import either.
 *
 * A Postgres that cannot be reached is NOT fatal here. Several packages have suites that
 * never touch a database, and failing their run because Docker is down would be a worse
 * answer than the connection error the suites that do need it will raise for themselves.
 * It is reported rather than swallowed.
 */
export default async function setup(): Promise<void> {
  try {
    const outcome = await ensureDatabaseExists(TEST_DATABASE_URL);
    if (outcome === 'created') {
      const name = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
      process.stderr.write(`[vitest] created the test database "${name}"\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[vitest] could not prepare the test database (${(error as Error).message}). ` +
        'Suites that need Postgres will fail; the rest will run.\n',
    );
  }
}
