import type { Pool } from 'pg';
import { describe, expect, test, vi } from 'vitest';
import { withTx } from '../src/tx.js';

/** Minimal fake pool: connect() hands back a client whose query() we record. */
function fakePool() {
  const client = {
    query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client };
}

function pgError(code: string): Error & { code: string } {
  const e = new Error(`sqlstate ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

describe('withTx', () => {
  test('retries the transaction on a deadlock and eventually commits', async () => {
    const { pool, client } = fakePool();
    let calls = 0;
    const result = await withTx(pool, async () => {
      calls += 1;
      if (calls === 1) throw pgError('40P01'); // deadlock_detected on the first try
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    const sql = client.query.mock.calls.map((c) => c[0]);
    expect(sql.filter((s) => s === 'BEGIN')).toHaveLength(2); // one aborted, one committed
    expect(sql).toContain('ROLLBACK');
    expect(sql).toContain('COMMIT');
  });

  test('retries a serialization failure too', async () => {
    const { pool } = fakePool();
    let calls = 0;
    const result = await withTx(pool, async () => {
      calls += 1;
      if (calls === 1) throw pgError('40001'); // serialization_failure
      return calls;
    });
    expect(result).toBe(2);
  });

  test('does not retry a non-deadlock error', async () => {
    const { pool } = fakePool();
    let calls = 0;
    await expect(
      withTx(pool, async () => {
        calls += 1;
        throw pgError('23505'); // unique_violation — caller-handled, must propagate as-is
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
  });

  test('gives up after the max attempts if the deadlock persists', async () => {
    const { pool } = fakePool();
    let calls = 0;
    await expect(
      withTx(pool, async () => {
        calls += 1;
        throw pgError('40P01');
      }),
    ).rejects.toMatchObject({ code: '40P01' });
    expect(calls).toBe(3);
  });
});
