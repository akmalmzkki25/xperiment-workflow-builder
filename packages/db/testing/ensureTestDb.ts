import { TEST_DATABASE_URL } from '../../../vitest.shared.js';
import { ensureDatabaseExists } from '../src/ensureDatabase.js';

/**
 * Create the test database, as a command.
 *
 * The vitest suites call `ensureDatabaseExists` directly, but Playwright transpiles its
 * setup file to CommonJS and cannot import this package at all — `migrate.ts` uses
 * `import.meta.url`, which is a syntax error there. Spawning this is how that suite gets
 * the same one implementation instead of a second copy of it.
 */
const outcome = await ensureDatabaseExists(TEST_DATABASE_URL);
const name = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
process.stderr.write(`test database "${name}" ${outcome}\n`);
