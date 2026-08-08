export const REDACTED = '[redacted]';

/**
 * Key names that carry a credential often enough to be worth blanking on the way out.
 * Anchored, so a field called `tokenCount` or `passwordChangedAt` is left alone.
 */
const SECRET_KEY = new RegExp(
  '^(?:' +
    'authorization|proxy-authorization|cookie|set-cookie|' +
    'x-api-key|api[_-]?key|apikey|' +
    'access[_-]?token|refresh[_-]?token|id[_-]?token|bot[_-]?token|' +
    'server[_-]?key|secret[_-]?key|private[_-]?key|' +
    'token|secret|client[_-]?secret|' +
    'password|passwd|pwd|' +
    'connection[_-]?string|dsn|signature' +
    ')$',
  'i',
);

const MAX_DEPTH = 8;

/**
 * Blanks the VALUE wherever the KEY looks like a credential.
 *
 * This is defence in depth, not a guarantee, and the distinction matters: a token
 * concatenated into a URL string, or one sitting under a key nobody thought to name,
 * passes straight through. The real protection is that decrypted connection payloads
 * are never persisted — they travel as `ctx.connection` and are dropped after the run,
 * so what lands in `input_json` is only what the author typed into a parameter.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    // defineProperty, not assignment: a key literally named __proto__ would otherwise
    // hit the inherited setter and vanish from the response.
    Object.defineProperty(out, key, {
      value: SECRET_KEY.test(key) ? REDACTED : redactSecrets(v, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
