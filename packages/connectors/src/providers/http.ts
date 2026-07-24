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

export async function providerCheck(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: headers ?? {} });
  } catch {
    throw new Error('connection test failed (network)');
  }
  if (!res.ok) throw new Error(`connection test failed (${res.status})`);
}
