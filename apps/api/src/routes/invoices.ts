import { appendAuditEvent, getInvoice, listInvoices, markInvoicePaid, setInvoiceProvider, withTx } from '@xperiment/db';
import { providerFor } from '@xperiment/payments';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `.int()` matters: a fractional limit reaches `LIMIT $2`, which Postgres infers as
// bigint, and the 22P02 surfaces as a 500 carrying the driver's error text.
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(24) });

export function registerInvoiceRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/v1/invoices', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:read')) return;
    const q = listQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return sendProblem(reply, 400, 'Invalid query', q.error.message);
    return { items: await listInvoices(deps.pool, ctx.workspaceId, q.data.limit) };
  });

  app.get('/v1/invoices/:id', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:read')) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return sendProblem(reply, 404, 'Invoice not found'); // avoid a pg 22P02 500
    const found = await getInvoice(deps.pool, id, ctx.workspaceId);
    if (!found) return sendProblem(reply, 404, 'Invoice not found');
    return found;
  });

  app.post('/v1/invoices/:id/pay', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:manage')) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return sendProblem(reply, 404, 'Invoice not found');
    const found = await getInvoice(deps.pool, id, ctx.workspaceId);
    if (!found) return sendProblem(reply, 404, 'Invoice not found');
    if (found.invoice.status !== 'issued') {
      return sendProblem(reply, 409, 'Invoice not payable', `Status is ${found.invoice.status}`);
    }
    const charge = await deps.paymentProvider.createCharge({
      invoiceId: found.invoice.id,
      workspaceId: ctx.workspaceId,
      totalMinor: found.invoice.totalMinor,
      currency: found.invoice.currency,
    });
    await withTx(deps.pool, async (client) => {
      await setInvoiceProvider(client, {
        id,
        workspaceId: ctx.workspaceId,
        provider: deps.paymentProvider.key,
        providerRef: charge.reference,
      });
      // Audits the local record, not the charge: createCharge already happened above, so a
      // provider success followed by a failed write leaves no row. Restructuring that
      // ordering is out of scope here.
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'invoice.pay',
        targetType: 'invoice',
        targetId: id,
        metadata: {
          totalMinor: found.invoice.totalMinor,
          currency: found.invoice.currency,
          provider: deps.paymentProvider.key,
        },
      });
    });
    return { provider: deps.paymentProvider.key, ...charge };
  });

  app.post('/v1/invoices/:id/mark-paid', async (req, reply) => {
    const ctx = authOf(req);
    if (!requirePermission(reply, ctx, 'billing:manage')) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return sendProblem(reply, 404, 'Invoice not found');
    const found = await getInvoice(deps.pool, id, ctx.workspaceId);
    if (!found) return sendProblem(reply, 404, 'Invoice not found');
    const settled = await withTx(deps.pool, async (client) => {
      const ok = await markInvoicePaid(client, {
        id,
        workspaceId: ctx.workspaceId,
        provider: found.invoice.provider ?? deps.paymentProvider.key,
        providerRef: found.invoice.providerRef ?? 'manual-settlement',
      });
      if (!ok) return false;
      // Manual settlement moves an invoice to paid with no provider record behind it, so
      // this row is the only answer to "who marked it paid".
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'invoice.mark_paid',
        targetType: 'invoice',
        targetId: id,
        metadata: { totalMinor: found.invoice.totalMinor, currency: found.invoice.currency },
      });
      return true;
    });
    // CAS: a replay settles nothing rather than paying twice.
    if (!settled) return sendProblem(reply, 409, 'Invoice already settled', `Status is ${found.invoice.status}`);
    return { status: 'paid' };
  });

  // Unauthenticated by design — the signature is the credential. Anything that cannot be
  // positively verified is a 401 that mutates nothing.
  app.post('/v1/payments/:provider/webhook', async (req, reply) => {
    const { provider: key } = req.params as { provider: string };
    const provider = providerFor(key);
    if (!provider || !deps.paymentWebhookSecret) return sendProblem(reply, 401, 'Unverified webhook');
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const verdict = provider.verifyWebhook(
      raw,
      req.headers as Record<string, string | undefined>,
      deps.paymentWebhookSecret,
    );
    // Never log `raw` — a provider body can carry secrets.
    if (!verdict) return sendProblem(reply, 401, 'Unverified webhook');

    const found = await deps.pool.query(
      `SELECT id, workspace_id FROM invoices WHERE provider_ref = $1 AND provider = $2`,
      [verdict.invoiceRef, provider.key],
    );
    const row = found.rows[0] as { id: string; workspace_id: string } | undefined;
    if (!row) return sendProblem(reply, 404, 'Unknown invoice reference');
    if (verdict.status === 'paid') {
      await markInvoicePaid(deps.pool, {
        id: row.id,
        workspaceId: row.workspace_id,
        provider: provider.key,
        providerRef: verdict.invoiceRef,
      });
    }
    return { received: true };
  });
}
