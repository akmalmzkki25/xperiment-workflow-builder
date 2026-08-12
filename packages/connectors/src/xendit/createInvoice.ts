import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { basicAuth, httpStatusOf, providerCheck, providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    /** Xendit's idempotency handle. A repeat is refused, not silently reused. */
    externalId: z.string().min(1).max(255),
    // IDR has no minor unit.
    amount: z.number().int().positive(),
    payerEmail: z.string().email().optional(),
    description: z.string().min(1).max(255).optional(),
    /** Seconds. Xendit's own bounds: at least a minute, at most a year. */
    invoiceDuration: z.number().int().min(60).max(31536000).optional(),
  })
  .strict();

const DEFAULT_BASE = 'https://api.xendit.co';

function connOf(payload: unknown): { secretKey: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.xendit.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid xendit connection payload', false);
  return parsed.data;
}

export const xenditCreateInvoice: ConnectorDefinition = {
  type: 'xendit.createInvoice',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Create Xendit invoice',
    description:
      'Create a Xendit invoice and return its payment URL. Amounts are whole rupiah; externalId must be unique, because Xendit refuses a repeat rather than returning the original.',
    category: 'Payments',
    // A document rather than a currency mark: Xendit issues an invoice you send, where
    // Midtrans opens a checkout page. Different shapes on the canvas, deliberately.
    glyph: '▤',
    docsUrl: 'https://developers.xendit.co/api-reference/#create-invoice',
  },
  paramsSchema,
  requiresConnection: 'xendit',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const p = parsed.data;

    let data: { id?: string; invoice_url?: string; status?: string; expiry_date?: string };
    try {
      data = (await providerFetch(
        `${conn.baseUrl ?? DEFAULT_BASE}/v2/invoices`,
        {
          method: 'POST',
          headers: { authorization: basicAuth(conn.secretKey) },
          body: {
            external_id: p.externalId,
            amount: p.amount,
            ...(p.payerEmail ? { payer_email: p.payerEmail } : {}),
            ...(p.description ? { description: p.description } : {}),
            ...(p.invoiceDuration ? { invoice_duration: p.invoiceDuration } : {}),
          },
        },
        ctx.signal,
      )) as { id?: string; invoice_url?: string; status?: string; expiry_date?: string };
    } catch (e) {
      // 409 DUPLICATE_ERROR. Re-thrown WITHOUT a status: the worker's classifier
      // overrides the retryable flag for anything carrying one, and a duplicate will be
      // refused just as firmly on the second and third attempt.
      if (httpStatusOf(e) === 409) {
        throw new NodeRunError('duplicate_invoice', `xendit already has an invoice named ${p.externalId}`, false);
      }
      throw e;
    }

    if (typeof data.id !== 'string' || typeof data.invoice_url !== 'string') {
      throw new NodeRunError('provider_error', 'xendit returned no invoice url', false);
    }
    return {
      output: {
        invoiceId: data.id,
        invoiceUrl: data.invoice_url,
        status: data.status ?? null,
        expiresAt: data.expiry_date ?? null,
        externalId: p.externalId,
      },
    };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    // Genuinely read-only, unlike anything Snap offers.
    await providerCheck(`${conn.baseUrl ?? DEFAULT_BASE}/balance`, signal, {
      authorization: basicAuth(conn.secretKey),
    });
  },
};
