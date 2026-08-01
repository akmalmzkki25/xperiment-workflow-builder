import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32. '0', '1', '8' and 'I' are absent by design: they misread as O, l and B. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1;
const SECRET_BYTES = 20;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Left-over bits are padded with zeros rather than '='; every authenticator accepts this.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(SECRET_BYTES);
  return { secret, base32: base32Encode(secret) };
}

/**
 * One HOTP value for a counter, per RFC 4226's dynamic truncation. `digits` is a parameter
 * only so the RFC 6238 test vectors — which are eight digits — can be asserted directly;
 * everything in the product uses the six-digit default.
 */
export function totpCode(secret: Buffer, counter: number, digits: number = DEFAULT_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Returns the step the code matched, or null. `after` is a floor: no step at or below it is
 * ever accepted, which is what keeps the ±1 drift window from doubling as a replay window.
 */
export function verifyTotpCode(args: {
  secret: Buffer;
  code: string;
  now?: number;
  window?: number;
  digits?: number;
  after?: number | null;
}): number | null {
  const digits = args.digits ?? DEFAULT_DIGITS;
  if (args.code.length !== digits || !/^\d+$/.test(args.code)) return null;
  const current = Math.floor((args.now ?? Date.now()) / 1000 / TOTP_STEP_SECONDS);
  const window = args.window ?? DEFAULT_WINDOW;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (args.after != null && step <= args.after) continue;
    if (constantTimeEquals(totpCode(args.secret, step, digits), args.code)) return step;
  }
  return null;
}

export function otpauthUri(args: { issuer: string; account: string; base32: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: args.base32,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
