import { describe, expect, test } from 'vitest';
import { redactSecrets, REDACTED } from '../src/routes/redact.js';

describe('redactSecrets', () => {
  test('replaces the value of a secret-named key at any depth', () => {
    const input = {
      url: 'https://api.example.test/v1',
      headers: { authorization: 'Bearer sk-live-123', accept: 'application/json' },
      body: { nested: { apiKey: 'k-999', label: 'keep me' } },
    };
    expect(redactSecrets(input)).toEqual({
      url: 'https://api.example.test/v1',
      headers: { authorization: REDACTED, accept: 'application/json' },
      body: { nested: { apiKey: REDACTED, label: 'keep me' } },
    });
  });

  test('is case- and separator-insensitive across the usual spellings', () => {
    const input = {
      API_KEY: 'a',
      'api-key': 'b',
      apiKey: 'c',
      Authorization: 'd',
      access_token: 'e',
      botToken: 'f',
      'Client-Secret': 'g',
    };
    for (const value of Object.values(redactSecrets(input) as Record<string, unknown>)) {
      expect(value).toBe(REDACTED);
    }
  });

  test('leaves a key that merely contains a secret word alone', () => {
    // Anchored on purpose: blanking tokenCount would hide real data.
    expect(redactSecrets({ tokenCount: 12, passwordChangedAt: '2026-01-01', secretary: 'Budi' })).toEqual({
      tokenCount: 12,
      passwordChangedAt: '2026-01-01',
      secretary: 'Budi',
    });
  });

  test('preserves array shape and primitive values', () => {
    expect(redactSecrets([{ token: 'x' }, 1, 'two', null])).toEqual([{ token: REDACTED }, 1, 'two', null]);
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(7)).toBe(7);
  });

  test('keeps a data-supplied __proto__ key instead of dropping the subtree', () => {
    // Plain assignment onto a fresh object invokes the inherited setter and the key
    // silently vanishes from the response.
    const parsed = JSON.parse('{"__proto__":{"a":1},"keep":2}') as unknown;
    const out = redactSecrets(parsed) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'keep']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  test('blanks everything past the depth cap rather than returning it in the clear', () => {
    // Returning the raw subtree at the cap would defeat the redaction: a secret at
    // depth 9 would come back untouched, and ten levels is ordinary for a GraphQL or
    // Google API response landing in output_json.
    let deep: Record<string, unknown> = { token: 'sk-live-DEEP', apiKey: 'k-DEEP' };
    for (let i = 0; i < 40; i += 1) deep = { level: deep };
    const out = redactSecrets(deep);
    expect(JSON.stringify(out)).not.toContain('sk-live-DEEP');
    expect(JSON.stringify(out)).not.toContain('k-DEEP');
  });

  test('a secret just below the cap is still blanked', () => {
    let deep: Record<string, unknown> = { token: 'sk-live-9' };
    for (let i = 0; i < 9; i += 1) deep = { level: deep };
    expect(JSON.stringify(redactSecrets(deep))).not.toContain('sk-live-9');
  });

  test('covers the header names webhook providers actually invent', () => {
    // The gateway stores every header it does not explicitly strip, and webhook.trigger
    // returns that payload verbatim as its output_json — so an exhaustive list would
    // always be one provider behind.
    const headers = {
      'x-telegram-bot-api-secret-token': 'a',
      'x-goog-api-key': 'b',
      'x-amz-security-token': 'c',
      'x-hub-signature-256': 'd',
      sessionToken: 'e',
      webhook_secret: 'f',
      privateKeyPem: 'g',
      assertion: 'h',
      credential: 'i',
      auth: 'j',
    };
    for (const [key, value] of Object.entries(redactSecrets(headers) as Record<string, unknown>)) {
      expect(value, key).toBe(REDACTED);
    }
  });
});
