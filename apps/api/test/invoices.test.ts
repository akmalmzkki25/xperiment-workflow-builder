import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, issueInvoice, runMigrations } from '@xperiment/db';
import { buildInvoice, DEFAULT_TAX_RATE_BPS, previousPeriod, resolveLimits } from '@xperiment/plans';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
const period = previousPeriod(new Date());

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function seedInvoice(user: AuthedUser): Promise<string> {
  const draft = buildInvoice({
    planCode: 'builder',
    limits: resolveLimits('builder', {}),
    usage: { executionsPerMonth: 0, aiTokensPerMonth: 0, activeWorkflows: 0, members: 0 },
    taxRateBps: DEFAULT_TAX_RATE_BPS,
  });
  const inv = await issueInvoice(pool, {
    workspaceId: user.workspaceId,
    periodStart: period.start,
    periodEnd: period.end,
    planCode: 'builder',
    draft,
  });
  return inv!.id;
}

describe('GET /v1/invoices', () => {
  test('lists the workspace invoices for a billing reader', async () => {
    const user = await createAuthedUser(app);
    await seedInvoice(user);
    const billing = await addMemberWithRole(app, pool, user.workspaceId, 'billing');
    const r = await billing.inject({ method: 'GET', url: '/v1/invoices' });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  test('a viewer cannot read invoices', async () => {
    const user = await createAuthedUser(app);
    const viewer = await addMemberWithRole(app, pool, user.workspaceId, 'viewer');
    expect((await viewer.inject({ method: 'GET', url: '/v1/invoices' })).statusCode).toBe(403);
  });
});

describe('GET /v1/invoices/:id', () => {
  test('returns the invoice with its lines', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    const r = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ invoice: { status: string }; lines: { kind: string }[] }>();
    expect(body.invoice.status).toBe('issued');
    expect(body.lines[0]!.kind).toBe('subscription');
  });

  test('404s another workspace invoice', async () => {
    const owner = await createAuthedUser(app);
    const id = await seedInvoice(owner);
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'GET', url: `/v1/invoices/${id}` })).statusCode).toBe(404);
  });

  test('404s a malformed id rather than raising a pg error', async () => {
    const user = await createAuthedUser(app);
    expect((await user.inject({ method: 'GET', url: '/v1/invoices/not-a-uuid' })).statusCode).toBe(404);
  });
});

describe('payment', () => {
  test('pay returns a reference and records the provider without settling', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    const r = await user.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ reference: string; instructions: string }>();
    expect(body.reference).toMatch(/^XPERIMENT-/);
    const after = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    const invoice = after.json<{ invoice: { status: string; providerRef: string } }>().invoice;
    expect(invoice.status).toBe('issued');
    expect(invoice.providerRef).toBe(body.reference);
  });

  test('pay is idempotent — the same invoice yields the same reference', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    const a = await user.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    const b = await user.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    expect(a.json<{ reference: string }>().reference).toBe(b.json<{ reference: string }>().reference);
  });

  test('mark-paid settles once and 409s the replay', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    expect((await user.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(200);
    expect((await user.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(409);
    const after = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    expect(after.json<{ invoice: { status: string } }>().invoice.status).toBe('paid');
  });

  test('paying a settled invoice is refused', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    await user.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    expect((await user.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` })).statusCode).toBe(409);
  });

  test('an operator cannot settle an invoice', async () => {
    const owner = await createAuthedUser(app);
    const id = await seedInvoice(owner);
    const operator = await addMemberWithRole(app, pool, owner.workspaceId, 'operator');
    expect((await operator.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(403);
  });

  test('a billing member can settle', async () => {
    const owner = await createAuthedUser(app);
    const id = await seedInvoice(owner);
    const billing = await addMemberWithRole(app, pool, owner.workspaceId, 'billing');
    expect((await billing.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(200);
  });

  test('cannot settle another workspace invoice', async () => {
    const owner = await createAuthedUser(app);
    const id = await seedInvoice(owner);
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` })).statusCode).toBe(404);
  });
});

describe('POST /v1/payments/:provider/webhook', () => {
  test('401s an unknown provider', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/payments/midtrans/webhook', payload: {} });
    expect(r.statusCode).toBe(401);
  });

  test('401s the manual provider, which has no callback', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/payments/manual/webhook', payload: { any: 'thing' } });
    expect(r.statusCode).toBe(401);
  });

  test('is refused without authentication rather than gated by a permission', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/payments/manual/webhook', payload: {} });
    expect(r.statusCode).not.toBe(403);
  });

  test('an unverifiable webhook settles nothing', async () => {
    const user = await createAuthedUser(app);
    const id = await seedInvoice(user);
    await user.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    await app.inject({ method: 'POST', url: '/v1/payments/manual/webhook', payload: { status: 'paid' } });
    const after = await user.inject({ method: 'GET', url: `/v1/invoices/${id}` });
    expect(after.json<{ invoice: { status: string } }>().invoice.status).toBe('issued');
  });
});
