import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { basicAuth, httpStatusOf, providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const itemSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).max(50),
    // IDR has no minor unit, so every amount here is a whole rupiah.
    price: z.number().int().nonnegative(),
    quantity: z.number().int().positive(),
  })
  .strict();

const paramsSchema = z
  .object({
    orderId: z.string().min(1).max(50),
    grossAmount: z.number().int().positive(),
    itemDetails: z.array(itemSchema).min(1).max(50).optional(),
    customerFirstName: z.string().min(1).max(255).optional(),
    customerEmail: z.string().email().optional(),
    customerPhone: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.itemDetails === undefined ||
      p.grossAmount === p.itemDetails.reduce((sum, i) => sum + i.price * i.quantity, 0),
    {
      // Midtrans answers 400 when these disagree. Catching it here names the actual
      // problem instead of relaying a generic provider rejection.
      message: 'grossAmount must equal the sum of price × quantity across itemDetails',
      path: ['grossAmount'],
    },
  );

/**
 * Sandbox by default, deliberately.
 *
 * A misconfigured connection that reaches sandbox costs nothing. The same mistake against
 * production creates a real payment page for a real customer. Production is one explicit
 * `baseUrl` away.
 */
const DEFAULT_BASE = 'https://app.sandbox.midtrans.com';

function connOf(payload: unknown): { serverKey: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.midtrans.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid midtrans connection payload', false);
  return parsed.data;
}

export const midtransCreateTransaction: ConnectorDefinition = {
  type: 'midtrans.createTransaction',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Create Midtrans payment',
    description:
      'Create a Midtrans Snap transaction and return the payment page URL. Amounts are whole rupiah; orderId must be unique, because Midtrans refuses a repeat.',
    category: 'Payments',
    // One code point, matching the '☏' / '#' house style. 'Rp' would be two.
    glyph: '¤',
    docsUrl: 'https://docs.midtrans.com/docs/snap-snap-integration-guide',
  },
  paramsSchema,
  requiresConnection: 'midtrans',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const p = parsed.data;
    const customer = {
      ...(p.customerFirstName ? { first_name: p.customerFirstName } : {}),
      ...(p.customerEmail ? { email: p.customerEmail } : {}),
      ...(p.customerPhone ? { phone: p.customerPhone } : {}),
    };

    let data: { token?: string; redirect_url?: string };
    try {
      data = (await providerFetch(
        `${conn.baseUrl ?? DEFAULT_BASE}/snap/v1/transactions`,
        {
          method: 'POST',
          headers: { authorization: basicAuth(conn.serverKey), accept: 'application/json' },
          body: {
            transaction_details: { order_id: p.orderId, gross_amount: p.grossAmount },
            ...(p.itemDetails
              ? {
                  item_details: p.itemDetails.map((i) => ({
                    id: i.id ?? i.name,
                    name: i.name,
                    price: i.price,
                    quantity: i.quantity,
                  })),
                }
              : {}),
            ...(Object.keys(customer).length > 0 ? { customer_details: customer } : {}),
          },
        },
        ctx.signal,
      )) as { token?: string; redirect_url?: string };
    } catch (e) {
      // 406 is Midtrans for "that order_id already exists". Re-thrown WITHOUT a status:
      // the worker's classifier overrides the retryable flag for anything carrying one,
      // and retrying a duplicate is three more guaranteed refusals.
      if (httpStatusOf(e) === 406) {
        throw new NodeRunError('duplicate_order', `midtrans already has an order named ${p.orderId}`, false);
      }
      throw e;
    }

    if (typeof data.token !== 'string' || typeof data.redirect_url !== 'string') {
      throw new NodeRunError('provider_error', 'midtrans returned no snap token', false);
    }
    return { output: { token: data.token, redirectUrl: data.redirect_url, orderId: p.orderId } };
  },
  // No testConnection on purpose. Snap has no side-effect-free credential probe, and
  // inventing one by POSTing a throwaway transaction would leave real orders in a real
  // merchant dashboard every time somebody clicked Test.
};
