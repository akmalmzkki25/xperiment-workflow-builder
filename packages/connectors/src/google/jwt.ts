import { createSign } from 'node:crypto';
import { NodeRunError } from '../types.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Builds an RS256 service-account assertion JWT (deterministic given `now`). */
export function buildServiceAccountJwt(args: {
  email: string;
  privateKey: string;
  scope: string;
  aud: string;
  now: number;
}): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(args.now / 1000);
  const claims = b64url(
    JSON.stringify({ iss: args.email, scope: args.scope, aud: args.aud, iat, exp: iat + 3600 }),
  );
  const signingInput = `${header}.${claims}`;
  // A service-account key pasted from its JSON file carries escaped "\n"; restore
  // real newlines so the PEM parses.
  const pem = args.privateKey.includes('\\n') ? args.privateKey.replace(/\\n/g, '\n') : args.privateKey;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(pem, 'base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Exchanges a service-account JWT for a short-lived Google access token. The
 * token endpoint is overridable for tests. Never surfaces the key or provider
 * error text.
 */
export async function serviceAccountToken(
  conn: { serviceAccountEmail: string; privateKey: string; tokenUrl?: string },
  signal: AbortSignal,
): Promise<string> {
  const tokenUrl = conn.tokenUrl ?? DEFAULT_TOKEN_URL;
  let jwt: string;
  try {
    jwt = buildServiceAccountJwt({
      email: conn.serviceAccountEmail,
      privateKey: conn.privateKey,
      scope: SHEETS_SCOPE,
      aud: tokenUrl,
      now: Date.now(),
    });
  } catch {
    throw new NodeRunError('connection_invalid', 'invalid google service-account key', false);
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new NodeRunError('timeout', 'google token request timed out', false, { timeout: true });
    }
    throw new NodeRunError('network_error', 'google token request failed', true);
  }
  if (!res.ok) throw new NodeRunError('provider_error', `google token endpoint returned ${res.status}`, false);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new NodeRunError('provider_error', 'google token endpoint returned no token', false);
  return data.access_token;
}
