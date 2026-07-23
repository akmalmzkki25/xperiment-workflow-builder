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
