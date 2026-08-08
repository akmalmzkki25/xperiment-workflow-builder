import { randomUUID } from 'node:crypto';
import { buildInvoice, DEFAULT_TAX_RATE_BPS, previousPeriod, resolveLimits, type PlanCode } from '@xperiment/plans';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createPool,
  createUser,
  createWorkspaceWithOwner,
  getInvoice,
  issueInvoice,
  listInvoices,
  markInvoicePaid,
  runMigrations,
  setInvoiceProvider,
  workspacesNeedingInvoice,
} from '../src/index.js';

let pool: Pool;
const period = previousPeriod(new Date());

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});

async function newWorkspace(): Promise<string> {
  const user = await createUser(pool, { email: `inv-${randomUUID()}@xperiment.test`, passwordHash: 'x' });
  const ws = await createWorkspaceWithOwner(pool, { name: 'Inv', userId: user!.id, actor: { actorKind: 'system' } });
  return ws.id;
}

const draftFor = (planCode: PlanCode, executions = 0) =>
  buildInvoice({
    planCode,
    limits: resolveLimits(planCode, {}),
    usage: { executionsPerMonth: executions, aiTokensPerMonth: 0, activeWorkflows: 0, members: 0 },
    taxRateBps: DEFAULT_TAX_RATE_BPS,
  });

const issue = (workspaceId: string, planCode: PlanCode = 'builder', executions = 0) =>
  issueInvoice(pool, {
    workspaceId,
    periodStart: period.start,
    periodEnd: period.end,
    planCode,
    draft: draftFor(planCode, executions),
  });

describe('issueInvoice', () => {
  test('writes the invoice and its lines atomically', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    expect(inv).not.toBeNull();
    const full = await getInvoice(pool, inv!.id, ws);
    expect(full!.invoice.status).toBe('issued');
    expect(full!.invoice.totalMinor).toBe(draftFor('builder').totalMinor);
    expect(full!.lines).toHaveLength(1);
    expect(full!.lines[0]!.kind).toBe('subscription');
  });

  test('the period round-trips as the exact calendar dates it was issued for', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    // node-postgres parses a DATE into *local* midnight, so a naive toISOString() rolls
    // the day back east of Greenwich — this pins the boundary against that.
    expect(inv!.periodStart).toBe(period.start.toISOString().slice(0, 10));
    expect(inv!.periodEnd).toBe(period.end.toISOString().slice(0, 10));
    const reread = await getInvoice(pool, inv!.id, ws);
    expect(reread!.invoice.periodStart).toBe(inv!.periodStart);
    expect(reread!.invoice.periodEnd).toBe(inv!.periodEnd);
  });

  test('every persisted amount is an integer', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws, 'builder', 999_999);
    const full = await getInvoice(pool, inv!.id, ws);
    for (const v of [full!.invoice.subtotalMinor, full!.invoice.taxMinor, full!.invoice.totalMinor]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    for (const l of full!.lines) expect(Number.isInteger(l.amountMinor)).toBe(true);
  });

  test('a second issue for the same period returns null rather than throwing', async () => {
    const ws = await newWorkspace();
    expect(await issue(ws)).not.toBeNull();
    expect(await issue(ws)).toBeNull();
  });

  // The M and N lesson, twice proven: a sequential version of this passes against a
  // broken guard. Only a parallel one exercises the constraint.
  test('concurrent issues for one period produce exactly one invoice', async () => {
    const ws = await newWorkspace();
    await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT 1')));
    const results = await Promise.all(Array.from({ length: 5 }, () => issue(ws)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await pool.query(`SELECT count(*)::int AS c FROM invoices WHERE workspace_id = $1`, [ws]);
    expect((rows.rows[0] as { c: number }).c).toBe(1);
  }, 30000);
});

describe('reads are tenant-scoped', () => {
  test('getInvoice refuses another workspace', async () => {
    const [a, b] = [await newWorkspace(), await newWorkspace()];
    const inv = await issue(a);
    expect(await getInvoice(pool, inv!.id, b)).toBeNull();
  });

  test('listInvoices returns only this workspace, newest first', async () => {
    const ws = await newWorkspace();
    await issue(ws);
    const items = await listInvoices(pool, ws, 10);
    expect(items).toHaveLength(1);
    expect(items[0]!.workspaceId).toBe(ws);
  });
});

describe('markInvoicePaid', () => {
  test('settles an issued invoice once and refuses the replay', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    expect(
      await markInvoicePaid(pool, { id: inv!.id, workspaceId: ws, provider: 'manual', providerRef: 'XPERIMENT-1' }),
    ).toBe(true);
    expect(
      await markInvoicePaid(pool, { id: inv!.id, workspaceId: ws, provider: 'manual', providerRef: 'XPERIMENT-1' }),
    ).toBe(false);
    const full = await getInvoice(pool, inv!.id, ws);
    expect(full!.invoice.status).toBe('paid');
    expect(full!.invoice.paidAt).not.toBeNull();
  });

  test('refuses to settle another workspace invoice', async () => {
    const [a, b] = [await newWorkspace(), await newWorkspace()];
    const inv = await issue(a);
    expect(await markInvoicePaid(pool, { id: inv!.id, workspaceId: b, provider: 'manual', providerRef: 'X' })).toBe(
      false,
    );
  });

  test('setInvoiceProvider records the charge reference without settling', async () => {
    const ws = await newWorkspace();
    const inv = await issue(ws);
    expect(
      await setInvoiceProvider(pool, { id: inv!.id, workspaceId: ws, provider: 'manual', providerRef: 'XPERIMENT-9' }),
    ).toBe(true);
    const full = await getInvoice(pool, inv!.id, ws);
    expect(full!.invoice.providerRef).toBe('XPERIMENT-9');
    expect(full!.invoice.status).toBe('issued');
  });
});

describe('workspacesNeedingInvoice', () => {
  /**
   * The query is bounded and ordered by created_at, and nothing truncates `workspaces` —
   * this shared database carries thousands of rows from every other package's tests, all
   * of them needing an invoice for the closed period. Back-dating to the epoch puts the
   * row under test at the front, so a small limit reaches it.
   */
  let order = 0;
  async function oldWorkspace(): Promise<string> {
    const ws = await newWorkspace();
    order += 1;
    await pool.query(`UPDATE workspaces SET created_at = $2 WHERE id = $1`, [ws, new Date(order * 1000)]);
    return ws;
  }

  test('lists a workspace with no invoice for the period', async () => {
    const ws = await oldWorkspace();
    const ids = (await workspacesNeedingInvoice(pool, period, 20)).map((w) => w.workspaceId);
    expect(ids).toContain(ws);
  });

  test('omits a workspace already invoiced', async () => {
    const ws = await oldWorkspace();
    await issue(ws);
    const ids = (await workspacesNeedingInvoice(pool, period, 20)).map((w) => w.workspaceId);
    expect(ids).not.toContain(ws);
  });

  test('never returns more rows than the limit', async () => {
    // Unbounded, this returns every un-invoiced workspace — measured at 11,826 rows,
    // which the caller then walks at about eight round trips each.
    await oldWorkspace();
    await oldWorkspace();
    expect(await workspacesNeedingInvoice(pool, period, 1)).toHaveLength(1);
    expect(await workspacesNeedingInvoice(pool, period, 2)).toHaveLength(2);
  });

  test('returns the oldest workspaces first, so a bounded batch drains in order', async () => {
    // Ordering is what makes a bounded batch make progress instead of re-reading the
    // same head every tick.
    const older = await oldWorkspace();
    const newer = await oldWorkspace();
    const ids = (await workspacesNeedingInvoice(pool, period, 50)).map((w) => w.workspaceId);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });

  test('omits a workspace created after the period ended', async () => {
    const ws = await newWorkspace(); // created now, i.e. after any past period
    const ancient = { start: new Date(Date.UTC(2020, 0, 1)), end: new Date(Date.UTC(2020, 1, 1)) };
    const ids = (await workspacesNeedingInvoice(pool, ancient)).map((w) => w.workspaceId);
    expect(ids).not.toContain(ws);
  });
});
