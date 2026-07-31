import { randomUUID } from 'node:crypto';
import { createPool, createUser, createWorkspaceWithOwner, listInvoices, runMigrations } from '@xperiment/db';
import { previousPeriod } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runInvoiceSweep } from '../src/invoiceSweep.js';

let pool: Pool;
const period = previousPeriod(new Date());
const deps = () => ({ pool, log: () => {} });

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

/** A workspace back-dated into the closed period, on `planCode`, with `executions` used. */
async function seed(planCode: string, executions: number): Promise<string> {
  const user = await createUser(pool, { email: `sw-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Sweep', userId: user!.id, actor: { actorKind: 'system' } });
  await pool.query(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [ws.id, period.start]);
  await pool.query(`UPDATE workspace_plans SET plan_code = $2 WHERE workspace_id = $1`, [ws.id, planCode]);
  await pool.query(
    `INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
     VALUES ($1,$2,'execution',$3)
     ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = $3`,
    [ws.id, period.start, executions],
  );
  return ws.id;
}

describe('runInvoiceSweep', () => {
  test('issues one invoice for the closed period', async () => {
    const ws = await seed('builder', 10);
    await runInvoiceSweep(deps());
    const invoices = await listInvoices(pool, ws, 10);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.planCode).toBe('builder');
    expect(invoices[0]!.periodStart).toBe(period.start.toISOString().slice(0, 10));
  });

  test('is idempotent — a second sweep issues nothing more', async () => {
    const ws = await seed('builder', 5);
    await runInvoiceSweep(deps());
    await runInvoiceSweep(deps());
    expect(await listInvoices(pool, ws, 10)).toHaveLength(1);
  });

  test('bills overage from the closed period counters', async () => {
    const ws = await seed('builder', 10_050); // builder allows 10_000
    await runInvoiceSweep(deps());
    const full = (await listInvoices(pool, ws, 1))[0]!;
    // 149_000 subscription + 50 executions * 25 = 150_250 subtotal
    expect(full.subtotalMinor).toBe(149_000 + 50 * 25);
  });

  test('never invoices the current period', async () => {
    const ws = await seed('builder', 3);
    await runInvoiceSweep(deps());
    const invoices = await listInvoices(pool, ws, 10);
    const current = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    expect(invoices.map((i) => i.periodStart)).not.toContain(current);
  });

  test('one failing workspace does not stall the batch', async () => {
    const doomed = await seed('builder', 1);
    const good = await seed('builder', 2);
    // The sweep orders by created_at, and seed() back-dates every workspace to the same
    // period.start — a tie Postgres breaks arbitrarily. Without forcing `doomed` first,
    // `good` is often swept before the failure and the test passes even against a sweep
    // that aborts the whole batch on the first error.
    await pool.query(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [
      doomed,
      new Date(period.start.getTime() - 60_000),
    ]);

    // Inject a real failure for exactly one workspace. A pool wrapper is the honest way
    // to reach the catch: every value the sweep reads is schema-constrained, so there is
    // no legitimate row that makes it throw — and a test that never enters the catch
    // asserts nothing about the isolation it claims to prove.
    const failing = {
      query: (text: string, params?: unknown[]) => {
        if (text.includes('workspace_plans') && Array.isArray(params) && params[0] === doomed) {
          return Promise.reject(new Error('injected plan lookup failure'));
        }
        return pool.query(text, params as never);
      },
      connect: () => pool.connect(),
    } as unknown as Pool;

    const logged: string[] = [];
    const result = await runInvoiceSweep({ pool: failing, log: (msg) => logged.push(msg) });

    expect(logged).toContain('invoice_sweep.workspace_failed');
    expect(await listInvoices(pool, doomed, 10)).toHaveLength(0);
    expect(await listInvoices(pool, good, 10)).toHaveLength(1); // the batch continued
    expect(result.issued).toBeGreaterThanOrEqual(1);
  });
});
