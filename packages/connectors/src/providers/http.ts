import { NodeRunError } from '../types.js';

/** Shared provider fetch: JSON in/out, secret-free error messages, policy-ready facts. */
export async function providerFetch(
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
  signal: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new NodeRunError('timeout', 'provider request timed out', false, { timeout: true });
    }
    throw new NodeRunError('network_error', 'provider request failed', true);
  }
  if (!res.ok) {
    throw new NodeRunError('http_error', `provider returned ${res.status}`, false, { httpStatus: res.status });
  }
  return res.json();
}

/** HTTP Basic where the secret is the username and the password is empty. */
export function basicAuth(username: string): string {
  return `Basic ${Buffer.from(`${username}:`, 'utf8').toString('base64')}`;
}

/**
 * The status a `providerFetch` failure carried, or null.
 *
 * Providers signal specific, non-retryable business outcomes with an HTTP status —
 * Midtrans returns 406 for a duplicate order, Xendit 409 for a duplicate invoice. Those
 * have to be recognised and RE-THROWN WITHOUT a status, because
 * `apps/worker/src/classify.ts` overrides the connector's own retryable flag for any
 * error carrying `details.httpStatus`. Left alone, a duplicate order is retried three
 * times against a provider that will keep saying no.
 */
export function httpStatusOf(e: unknown): number | null {
  if (!(e instanceof NodeRunError)) return null;
  const details = e.details as { httpStatus?: unknown } | undefined;
  return typeof details?.httpStatus === 'number' ? details.httpStatus : null;
}

export async function providerCheck(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: headers ?? {} });
  } catch {
    throw new Error('connection test failed (network)');
  }
  if (!res.ok) throw new Error(`connection test failed (${res.status})`);
}
