import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  parseHandshake,
  verifyCallbackToken,
  verifyMetaSignature,
  verifyMidtransSignature,
} from '../src/verify.js';

const SECRET = 'trigger-secret-not-real';

describe('verifyMetaSignature', () => {
  const body = Buffer.from('{"entry":[{"id":"1"}]}');
  const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

  test('accepts a correct X-Hub-Signature-256 over the raw body', () => {
    // The inbound half of all three shipped WhatsApp templates could not be connected to
    // Meta at all before this: the gateway read only x-xperiment-signature, so every genuine
    // delivery failed auth.
    expect(verifyMetaSignature(sig, SECRET, body)).toBe(true);
  });

  test('rejects a signature over different bytes', () => {
    expect(verifyMetaSignature(sig, SECRET, Buffer.from('{"entry":[]}'))).toBe(false);
  });

  test('rejects a wrong secret, a missing header and a missing prefix', () => {
    expect(verifyMetaSignature(sig, 'other', body)).toBe(false);
    expect(verifyMetaSignature(undefined, SECRET, body)).toBe(false);
    expect(verifyMetaSignature(sig.slice('sha256='.length), SECRET, body)).toBe(false);
  });

  test('an empty body still verifies when it is what was signed', () => {
    const empty = Buffer.alloc(0);
    const emptySig = `sha256=${createHmac('sha256', SECRET).update(empty).digest('hex')}`;
    expect(verifyMetaSignature(emptySig, SECRET, empty)).toBe(true);
  });
});

describe('verifyCallbackToken', () => {
  test('accepts an exact match', () => {
    expect(verifyCallbackToken(SECRET, SECRET)).toBe(true);
  });

  test('rejects anything else', () => {
    expect(verifyCallbackToken('other', SECRET)).toBe(false);
    expect(verifyCallbackToken(undefined, SECRET)).toBe(false);
    expect(verifyCallbackToken('', SECRET)).toBe(false);
  });

  test('an empty stored secret never passes, even against an empty header', () => {
    // A trigger configured with no secret must not become an open endpoint the moment
    // somebody sends a blank header.
    expect(verifyCallbackToken('', '')).toBe(false);
    expect(verifyCallbackToken(undefined, '')).toBe(false);
  });
});

describe('verifyMidtransSignature', () => {
  function signed(overrides: Record<string, string> = {}): Record<string, string> {
    const base = { order_id: 'INV-1', status_code: '200', gross_amount: '56000.00', ...overrides };
    const key = createHash('sha512')
      .update(`${base.order_id}${base.status_code}${base.gross_amount}${SECRET}`, 'utf8')
      .digest('hex');
    return { ...base, signature_key: key };
  }

  test('accepts a correct SHA-512 over the concatenated body fields', () => {
    expect(verifyMidtransSignature(signed(), SECRET)).toBe(true);
  });

  test('gross_amount is used as the exact string Midtrans sent', () => {
    // The classic failure: parsing "56000.00" to a number and re-formatting it as "56000"
    // yields a different digest and rejects every genuine callback.
    const body = signed();
    expect(verifyMidtransSignature({ ...body, gross_amount: '56000' }, SECRET)).toBe(false);
  });

  test('any tampered field breaks it', () => {
    const body = signed();
    for (const field of ['order_id', 'status_code', 'gross_amount']) {
      expect(verifyMidtransSignature({ ...body, [field]: 'tampered' }, SECRET), field).toBe(false);
    }
  });

  test('a wrong server key is refused', () => {
    expect(verifyMidtransSignature(signed(), 'other-secret')).toBe(false);
  });

  test('a missing or non-string field is refused rather than coerced', () => {
    const body = signed();
    expect(verifyMidtransSignature({ ...body, gross_amount: 56000 }, SECRET)).toBe(false);
    const { order_id: _omitted, ...withoutOrder } = body;
    expect(verifyMidtransSignature(withoutOrder, SECRET)).toBe(false);
    expect(verifyMidtransSignature({ ...body, signature_key: '' }, SECRET)).toBe(false);
  });

  test('a non-object body is refused', () => {
    for (const body of [null, undefined, 'string', 42, []]) {
      expect(verifyMidtransSignature(body, SECRET)).toBe(false);
    }
  });

  test('an empty stored secret never passes', () => {
    expect(verifyMidtransSignature(signed(), '')).toBe(false);
  });
});

describe('parseHandshake', () => {
  const ok = { 'hub.mode': 'subscribe', 'hub.verify_token': SECRET, 'hub.challenge': '1158201444' };

  test('returns the challenge when the token matches', () => {
    expect(parseHandshake(ok, SECRET)).toBe('1158201444');
  });

  test('a wrong verify token yields null, and the caller must answer 404', () => {
    // Not 401. A distinguishable failure would let someone sweep route keys and learn
    // which ones exist without ever authenticating.
    expect(parseHandshake({ ...ok, 'hub.verify_token': 'wrong' }, SECRET)).toBeNull();
  });

  test('a trigger with no secret can never complete a handshake', () => {
    // Echoing a challenge to an unverified caller is the oracle with extra steps.
    expect(parseHandshake(ok, '')).toBeNull();
  });

  test('a mode other than subscribe is refused', () => {
    expect(parseHandshake({ ...ok, 'hub.mode': 'unsubscribe' }, SECRET)).toBeNull();
    const { 'hub.mode': _omitted, ...noMode } = ok;
    expect(parseHandshake(noMode, SECRET)).toBeNull();
  });

  test('the challenge shape is restricted, so this is not an open reflector', () => {
    // Without the cap anyone could have the endpoint return arbitrary text under our
    // own origin.
    for (const challenge of ['<script>alert(1)</script>', 'a b', '', 'x'.repeat(257), 'héllo', '../etc']) {
      expect(parseHandshake({ ...ok, 'hub.challenge': challenge }, SECRET), challenge).toBeNull();
    }
  });

  test('a challenge at the length limit is still accepted', () => {
    const challenge = 'x'.repeat(256);
    expect(parseHandshake({ ...ok, 'hub.challenge': challenge }, SECRET)).toBe(challenge);
  });

  test('a non-object or missing query is refused', () => {
    for (const query of [null, undefined, 'string', 42]) {
      expect(parseHandshake(query, SECRET)).toBeNull();
    }
  });

  test('array-valued parameters are refused rather than coerced', () => {
    // `?hub.challenge=a&hub.challenge=b` parses to an array; treating it as a string
    // would echo something nobody intended.
    expect(parseHandshake({ ...ok, 'hub.challenge': ['1', '2'] }, SECRET)).toBeNull();
    expect(parseHandshake({ ...ok, 'hub.verify_token': [SECRET] }, SECRET)).toBeNull();
  });
});
