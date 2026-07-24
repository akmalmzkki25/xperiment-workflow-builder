import { describe, expect, test } from 'vitest';
import { createDefaultRegistry, type NodeRunContext } from '../src/index.js';

const registry = createDefaultRegistry();
const def = () => registry.get('postgres.query')!;
const CONN = { connectionString: process.env['DATABASE_URL'] ?? 'postgresql://postgres:dev_password_change_me@localhost:5432/xperiment' };

function ctx(parameters: unknown, connection: unknown = CONN): NodeRunContext {
  return {
    executionId: 'e',
    nodeId: 'q',
    attempt: 1,
    parameters,
    triggerBody: null,
    connection,
    signal: AbortSignal.timeout(10000),
    log: () => {},
  };
}

describe('postgres.query', () => {
  test('declares its connection requirement', () => {
    expect(def().requiresConnection).toBe('postgres');
  });

  test('runs a parameterized select', async () => {
    const r = await def().run(ctx({ sql: 'SELECT $1::int AS n, $2::text AS s', params: [7, 'ok'] }));
    expect(r.output).toEqual({ rows: [{ n: 7, s: 'ok' }], rowCount: 1 });
  });

  test('query errors are non-retryable query_error', async () => {
    const err = await def()
      .run(ctx({ sql: 'SELECT * FROM definitely_missing_table' }))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('query_error');
    expect((err as { retryable: boolean }).retryable).toBe(false);
  });

  test('unreachable database is retryable network_error without leaking the conn string', async () => {
    const secret = 'postgres://user:supersecretpw@127.0.0.1:1/db';
    const err = await def()
      .run(ctx({ sql: 'SELECT 1' }, { connectionString: secret }))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('network_error');
    expect((err as { retryable: boolean }).retryable).toBe(true);
    expect((err as Error).message).not.toContain('supersecretpw');
  });

  test('testConnection succeeds against the real db and fails against a bad one', async () => {
    await expect(def().testConnection!(CONN, AbortSignal.timeout(10000))).resolves.toBeUndefined();
    await expect(
      def().testConnection!({ connectionString: 'postgres://x:y@127.0.0.1:1/db' }, AbortSignal.timeout(5000)),
    ).rejects.toThrow();
  });
});
