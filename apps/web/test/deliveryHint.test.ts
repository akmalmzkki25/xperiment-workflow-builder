import { describe, expect, test } from 'vitest';
import { deliveryHint, deliveryTone, EXPECTED_HEADER } from '../src/lib/deliveryHint';

const base = { outcome: 'accepted', authMode: null as string | null, headersSeen: [] as string[], bodyBytes: 0 };

describe('deliveryHint', () => {
  test('names the wrong header AND the expected one, which is the whole feature', () => {
    // A row saying "unauthorized / meta / [x-xperiment-signature]" is already the answer, but
    // only to someone who knows Meta signs under X-Hub-Signature-256.
    const hint = deliveryHint({
      ...base,
      outcome: 'unauthorized',
      authMode: 'meta',
      headersSeen: ['x-xperiment-signature'],
    });
    expect(hint).toContain('x-xperiment-signature');
    expect(hint).toContain('x-hub-signature-256');
  });

  test('the right header with a bad value points at the secret, not the header', () => {
    const hint = deliveryHint({
      ...base,
      outcome: 'unauthorized',
      authMode: 'meta',
      headersSeen: ['x-hub-signature-256'],
    });
    expect(hint).toContain('did not verify');
    expect(hint).toContain('secret');
  });

  test('no credential at all says so plainly', () => {
    const hint = deliveryHint({ ...base, outcome: 'unauthorized', authMode: 'xendit', headersSeen: [] });
    expect(hint).toContain('No credential');
    expect(hint).toContain('x-callback-token');
  });

  test('an idempotency key is not mistaken for an attempted credential', () => {
    // Otherwise the hint reads "you sent idempotency-key but this expects
    // x-callback-token", which is technically true and completely unhelpful.
    const hint = deliveryHint({
      ...base,
      outcome: 'unauthorized',
      authMode: 'xendit',
      headersSeen: ['idempotency-key'],
    });
    expect(hint).toContain('No credential');
  });

  test('midtrans points at the body and at the amount-formatting trap', () => {
    const hint = deliveryHint({ ...base, outcome: 'unauthorized', authMode: 'midtrans', headersSeen: [] });
    expect(hint).toContain('signature_key');
    expect(hint).toContain('gross_amount');
  });

  test('an auth mode nobody has written a hint for still says something true', () => {
    const hint = deliveryHint({ ...base, outcome: 'unauthorized', authMode: 'sha3_someday', headersSeen: [] });
    expect(hint).toContain('sha3_someday');
  });

  test('every non-unauthorized outcome has its own sentence', () => {
    for (const outcome of ['accepted', 'duplicate', 'invalid_json', 'too_large', 'quota_exceeded', 'inactive']) {
      const hint = deliveryHint({ ...base, outcome, bodyBytes: 42 });
      expect(hint.length, outcome).toBeGreaterThan(10);
      expect(hint, outcome).not.toContain('undefined');
    }
  });

  test('an unrecognised outcome does not render "undefined"', () => {
    expect(deliveryHint({ ...base, outcome: 'something_new' })).toBe('Outcome: something_new.');
  });

  test('every auth mode the trigger accepts has an expected header entry', () => {
    // webhook.trigger's enum, minus 'none' which never verifies anything.
    for (const mode of ['token', 'hmac', 'meta', 'xendit', 'midtrans']) {
      expect(EXPECTED_HEADER[mode], mode).toBeDefined();
    }
  });
});

describe('deliveryTone', () => {
  test('accepted reads as success, a rejection as failure, a duplicate as neither', () => {
    expect(deliveryTone('accepted')).toBe('succeeded');
    expect(deliveryTone('duplicate')).toBe('muted');
    expect(deliveryTone('unauthorized')).toBe('failed');
    expect(deliveryTone('invalid_json')).toBe('failed');
  });
});
