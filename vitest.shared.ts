/**
 * Where the test suite's data lives.
 *
 * NOT the dev stack's database. `pnpm dev` runs an orchestrator whose outbox publisher
 * polls `task_outbox` every 250ms and claims whatever it finds, so a suite that seeds rows
 * and then asserts on claiming them loses a random handful to it — the failures moved
 * around between runs and every package passed on its own. The queue suite is worse than
 * that: it calls `obliterate` on the BullMQ queues in `beforeEach`, which would delete the
 * running stack's jobs.
 *
 * Separate database, separate Redis logical database. Override either with
 * `TEST_DATABASE_URL` / `TEST_REDIS_URL` — Redis db 1 is a claim about what is free on a
 * developer's machine, not a fact.
 *
 * Deliberately dependency-free and free of `import.meta`: Playwright transpiles the files
 * that import this to CommonJS, where `import.meta.url` is a syntax error. That is why the
 * globalSetup path is a plain relative string in each vitest config rather than resolved
 * here.
 */
export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment_test';

export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://:dev_password_change_me@localhost:6379/1';

/**
 * Applied through vitest's `test.env`, so anything calling `createPool()` or
 * `createRedisConnection()` picks it up without knowing it is under test — including the
 * services the e2e suites spawn, which inherit `process.env`.
 */
export const testEnv: Record<string, string> = {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
};
