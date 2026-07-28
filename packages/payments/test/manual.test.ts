import { describe, expect, test } from 'vitest';
import { manualProvider, providerFor, PROVIDER_KEYS } from '../src/index.js';

const req = {
  invoiceId: '11111111-1111-1111-1111-111111111111',
  workspaceId: '22222222-2222-2222-2222-222222222222',
  totalMinor: 165_390,
  currency: 'IDR',
};

describe('providerFor', () => {
  test('resolves every advertised key', () => {
    for (const key of PROVIDER_KEYS) expect(providerFor(key)?.key).toBe(key);
  });

  test('returns null for an unknown key rather than throwing', () => {
    expect(providerFor('midtrans')).toBeNull();
    expect(providerFor('')).toBeNull();
  });

  test('a prototype key cannot resolve to a provider', () => {
    expect(providerFor('__proto__')).toBeNull();
    expect(providerFor('constructor')).toBeNull();
    expect(providerFor('toString')).toBeNull();
  });
});

describe('manualProvider', () => {
  test('produces a deterministic reference for an invoice', async () => {
    const a = await manualProvider.createCharge(req);
    const b = await manualProvider.createCharge(req);
    expect(a.reference).toBe(b.reference);
    expect(a.reference).toMatch(/^XPERIMENT-/);
  });

  test('a different invoice gets a different reference', async () => {
    const other = await manualProvider.createCharge({ ...req, invoiceId: '33333333-3333-3333-3333-333333333333' });
    expect(other.reference).not.toBe((await manualProvider.createCharge(req)).reference);
  });

  test('the instructions name the amount and the reference', async () => {
    const charge = await manualProvider.createCharge(req);
    expect(charge.instructions).toContain(charge.reference);
    expect(charge.instructions).toContain('165390');
  });

  test('never verifies a webhook — a manual transfer has no callback', () => {
    expect(manualProvider.verifyWebhook('{}', {}, 'secret')).toBeNull();
    expect(manualProvider.verifyWebhook('', {}, '')).toBeNull();
  });
});
