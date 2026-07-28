import { createHash } from 'node:crypto';

export interface ChargeRequest {
  invoiceId: string;
  workspaceId: string;
  totalMinor: number;
  currency: string;
}

export interface ChargeResult {
  reference: string;
  instructions: string;
}

export interface WebhookVerdict {
  invoiceRef: string;
  status: 'paid' | 'failed';
}

export interface PaymentProvider {
  readonly key: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /**
   * The verdict, or `null` for anything that cannot be positively verified — a bad
   * signature, a malformed body, an event we do not model. Returning null rather than
   * throwing keeps the caller's failure path total: unverified means mutate nothing.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, secret: string): WebhookVerdict | null;
}

/**
 * Bank transfer settled by an admin. It is a real provider, not a stub: it issues a
 * stable reference a customer can quote on a transfer, and settlement happens through
 * the mark-paid route rather than a callback.
 */
export const manualProvider: PaymentProvider = {
  key: 'manual',
  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    // Deterministic so re-requesting payment for one invoice never mints a second
    // reference the customer might quote on a duplicate transfer.
    const digest = createHash('sha256').update(req.invoiceId).digest('hex').slice(0, 12).toUpperCase();
    const reference = `XPERIMENT-${digest}`;
    return {
      reference,
      instructions: `Transfer ${req.totalMinor} ${req.currency} and quote reference ${reference}. An administrator marks the invoice paid once the transfer clears.`,
    };
  },
  verifyWebhook(): WebhookVerdict | null {
    return null;
  },
};

const PROVIDERS: Record<string, PaymentProvider> = { manual: manualProvider };

export const PROVIDER_KEYS: readonly string[] = Object.keys(PROVIDERS);

/** Null for an unknown key. Own-property lookup, so `__proto__` cannot resolve. */
export function providerFor(key: string): PaymentProvider | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? (PROVIDERS[key] ?? null) : null;
}
