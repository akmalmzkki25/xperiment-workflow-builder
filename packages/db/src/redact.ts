export const REDACTED = '[redacted]';

/**
 * Key names that carry a credential often enough to be worth blanking on the way out.
 * Anchored, so a field called `tokenCount` or `passwordChangedAt` is left alone.
 */
const SECRET_KEY = new RegExp(
  '^(?:' +
    'authorization|proxy-authorization|cookie|set-cookie|auth|bearer|' +
    // Any x-*-token / x-*-key / x-*-secret / x-*-signature header. Webhook providers
    // invent these freely — x-goog-api-key, x-amz-security-token,
    // x-telegram-bot-api-secret-token — and the gateway stores every header it does not
    // explicitly strip, so an exhaustive list would always be one provider behind.
    'x-(?:[a-z0-9-]*-)?(?:token|key|secret|signature)(?:-[a-z0-9]+)*|' +
    'x-api-key|api[_-]?key|apikey|' +
    '[a-z]*[_-]?(?:access|refresh|id|bot|session|resume)[_-]?token|' +
    '(?:server|secret|private|public|signing|webhook)[_-]?key(?:[_-]?pem)?|' +
    'token|secret|client[_-]?secret|webhook[_-]?secret|' +
    'password|passwd|pwd|passphrase|' +
    'assertion|credential|credentials|' +
    'connection[_-]?string|dsn|signature' +
    ')$',
  'i',
);

const MAX_DEPTH = 8;

/**
 * Blanks the VALUE wherever the KEY looks like a credential.
 *
 * Defence in depth, not a guarantee, and the distinction matters. Known to pass through:
 * a token concatenated into a URL string (`?api_key=…`), a credential sitting in an array
 * element rather than an object value, and any key nobody thought to name.
 *
 * The one guarantee that IS load-bearing: a decrypted connection payload can never reach
 * `input_json` or `output_json`. It travels as `ctx.connection` into `def.run()` and is
 * never written by any `casNode` patch. What DOES land in `input_json` is not merely
 * author-typed text — `resolveTemplate` returns whole evaluated values, so a parameter of
 * `{{ trigger.body }}` writes the entire webhook payload there.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  // Blank, not pass through. Returning the raw subtree past the cap would defeat the
  // redaction this function exists to perform — a secret at depth 9 would be in the
  // clear, and ten levels is ordinary for a GraphQL or Google API response.
  if (depth > MAX_DEPTH) return REDACTED;
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

/**
 * Does this text contain something shaped like a credential we actually accept?
 *
 * `redactSecrets` matches key *names*, so it is blind to a token somebody pastes as free
 * text into a chat box — which is the one place a conversational builder invites exactly
 * that. This is the complement: it matches the *shapes* of the credentials Xperiment's own
 * connectors take, so a hit can refuse the turn rather than scrub it silently. Refusing is
 * the right answer, because a scrubbed transcript still means the value transited the
 * logs and, worse, the model provider.
 *
 * Deliberately narrow. A false positive rejects somebody's legitimate message, so this
 * matches only formats with a distinctive prefix or separator — never "a long random
 * string", which would swallow a chat id, an order number, or a UUID.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  // Telegram bot token: 8-10 digits, a colon, then 35 of Telegram's alphabet.
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  // Slack bot/user/app tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  // OpenAI and OpenRouter style.
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // Xendit.
  /\bxnd_[A-Za-z0-9_]{16,}/,
  // Midtrans server keys.
  /\b(?:SB-)?Mid-server-[A-Za-z0-9_-]{10,}/,
  // A PEM private key, which is what a Google service account key looks like pasted.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A connection string carrying a password.
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/,
];

export function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some((re) => re.test(text));
}
