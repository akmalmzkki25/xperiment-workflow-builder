/**
 * Turns a delivery record into the sentence an operator needs.
 *
 * A row saying `unauthorized / meta / [x-xperiment-signature]` is already the answer, but only
 * to someone who knows that Meta signs under `X-Hub-Signature-256`. Spelling it out is the
 * difference between a diagnostic and a support ticket.
 */

/** The header each auth mode reads its credential from. */
export const EXPECTED_HEADER: Record<string, string> = {
  token: 'authorization',
  hmac: 'x-xperiment-signature',
  meta: 'x-hub-signature-256',
  xendit: 'x-callback-token',
  // Midtrans is the odd one: the digest is a field inside the JSON body.
  midtrans: '',
};

export interface DeliveryLike {
  outcome: string;
  authMode: string | null;
  headersSeen: readonly string[];
  bodyBytes: number;
}

export function deliveryHint(d: DeliveryLike): string {
  switch (d.outcome) {
    case 'accepted':
      return 'Accepted — a run was started.';
    case 'duplicate':
      return 'Same idempotency key as an earlier delivery, so it reused that run rather than starting a second.';
    case 'invalid_json':
      return `The body was not valid JSON (${d.bodyBytes} bytes).`;
    case 'too_large':
      return `The body was too large to store (${d.bodyBytes} bytes).`;
    case 'quota_exceeded':
      return 'Rejected because the workspace has reached its execution limit for this period.';
    case 'inactive':
      return 'The workflow or its trigger is not active, so production deliveries are refused.';
    case 'unauthorized':
      return unauthorizedHint(d);
    default:
      return `Outcome: ${d.outcome}.`;
  }
}

function unauthorizedHint(d: DeliveryLike): string {
  const mode = d.authMode ?? 'none';
  if (mode === 'midtrans') {
    return 'The signature_key in the body did not match. Check the server key, and note that gross_amount is hashed as the exact string Midtrans sent.';
  }
  const expected = EXPECTED_HEADER[mode];
  if (expected === undefined) return `Verification failed for auth mode "${mode}".`;
  if (d.headersSeen.includes(expected)) {
    return `Sent ${expected} as expected, but the value did not verify. The secret is probably out of date on the sender.`;
  }
  // The case worth building all of this for: the right idea, the wrong header.
  const sent = d.headersSeen.filter((h) => h !== 'idempotency-key');
  if (sent.length > 0) {
    return `Sent ${sent.join(', ')}, but this trigger expects ${expected}. Either change the trigger's auth mode or have the sender use ${expected}.`;
  }
  return `No credential arrived. This trigger expects ${expected}.`;
}

/** Colour bucket for the status chip, mapped to the run-status tokens already in use. */
export function deliveryTone(outcome: string): 'succeeded' | 'failed' | 'muted' {
  if (outcome === 'accepted') return 'succeeded';
  if (outcome === 'duplicate') return 'muted';
  return 'failed';
}
