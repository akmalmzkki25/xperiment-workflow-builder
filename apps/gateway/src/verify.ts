import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function verifyToken(authorizationHeader: string | undefined, secret: string): boolean {
  if (!authorizationHeader) return false;
  const [scheme, token, ...rest] = authorizationHeader.split(' ');
  if (scheme !== 'Bearer' || !token || rest.length > 0) return false;
  return safeEqual(token, secret);
}

export function verifyHmac(signatureHeader: string | undefined, secret: string, rawBody: Buffer): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(signatureHeader.slice('sha256='.length), expected);
}

/**
 * Meta signs with `X-Hub-Signature-256: sha256=<hex>` over the raw body.
 *
 * Same algorithm as `verifyHmac`, different header — which is exactly why the inbound
 * half of the three shipped WhatsApp templates could not be connected to Meta at all: the
 * gateway read only `x-xperiment-signature`, so every genuine Meta delivery failed auth.
 */
export function verifyMetaSignature(header: string | undefined, secret: string, rawBody: Buffer): boolean {
  return verifyHmac(header, secret, rawBody);
}

/**
 * Xendit sends a bare shared token in `x-callback-token` — no signature, no body binding.
 *
 * Weaker than an HMAC and that is Xendit's design, not a choice made here. Compared in
 * constant time regardless.
 */
export function verifyCallbackToken(header: string | undefined, secret: string): boolean {
  if (typeof header !== 'string' || header === '' || secret === '') return false;
  return safeEqual(header, secret);
}

/**
 * Midtrans puts `signature_key` INSIDE the JSON body:
 * `sha512(order_id + status_code + gross_amount + serverKey)`.
 *
 * The three body fields are concatenated as the exact strings Midtrans sent. Re-formatting
 * `gross_amount` — parsing "56000.00" to a number and back — produces a different digest
 * and rejects every genuine callback, which is the classic way this integration fails.
 */
export function verifyMidtransSignature(body: unknown, secret: string): boolean {
  if (secret === '' || body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const parts = [b['order_id'], b['status_code'], b['gross_amount']];
  if (!parts.every((p) => typeof p === 'string' && p !== '')) return false;
  const provided = b['signature_key'];
  if (typeof provided !== 'string' || provided === '') return false;
  const expected = createHash('sha512')
    .update(`${parts[0] as string}${parts[1] as string}${parts[2] as string}${secret}`, 'utf8')
    .digest('hex');
  return safeEqual(provided, expected);
}

/**
 * A challenge is echoed verbatim, so its shape is restricted.
 *
 * Meta sends a short numeric nonce. Without this cap the endpoint is an open reflector:
 * anyone could have it return arbitrary text under our origin.
 */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Meta's subscription handshake: `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`.
 *
 * Returns the challenge to echo, or null — and the caller must answer a null with 404,
 * never 401. A distinguishable failure would turn this into a route-key oracle: an
 * attacker could sweep keys and learn which ones exist without ever authenticating.
 *
 * A trigger with no secret can never pass, on purpose. Echoing a challenge to an
 * unverified caller is the oracle with extra steps.
 */
export function parseHandshake(query: unknown, secret: string): string | null {
  if (secret === '' || query === null || typeof query !== 'object') return null;
  const q = query as Record<string, unknown>;
  if (q['hub.mode'] !== 'subscribe') return null;
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];
  if (typeof token !== 'string' || typeof challenge !== 'string') return null;
  if (!CHALLENGE_PATTERN.test(challenge)) return null;
  if (!safeEqual(token, secret)) return null;
  return challenge;
}

export function extractDedupKey(body: unknown, path: string | null): string | null {
  if (!path) return null;
  let cur: unknown = body;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === 'string' && cur.length > 0) return cur;
  if (typeof cur === 'number') return String(cur);
  return null;
}

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'x-xperiment-signature']);

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    if (typeof v === 'string') out[lower] = v;
  }
  return out;
}
