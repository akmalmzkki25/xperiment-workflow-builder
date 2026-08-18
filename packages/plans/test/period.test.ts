import { describe, expect, test } from 'vitest';
import { billingPeriod, BILLING_TZ, previousPeriod } from '../src/index.js';

const at = (iso: string) => new Date(Date.parse(iso));

describe('billingPeriod', () => {
  test('the zone is the one the rest of the product schedules in', () => {
    expect(BILLING_TZ).toBe('Asia/Jakarta');
  });

  test('an instant early on the 1st WIB belongs to that month, not the previous one', () => {
    // 03:00 WIB on 1 August is 20:00 UTC on 31 July. Under UTC months this run was
    // counted into July — the whole defect, in one assertion.
    const p = billingPeriod(at('2026-08-01T03:00:00+07:00'));
    expect(p.key).toBe('2026-08-01');
  });

  test('an instant late on the last day WIB belongs to that month, not the next', () => {
    const p = billingPeriod(at('2026-08-31T23:30:00+07:00'));
    expect(p.key).toBe('2026-08-01');
  });

  test('the bounds are WIB midnights expressed as instants', () => {
    const p = billingPeriod(at('2026-08-15T10:00:00+07:00'));
    expect(p.startsAt.toISOString()).toBe('2026-07-31T17:00:00.000Z');
    expect(p.endsAt.toISOString()).toBe('2026-08-31T17:00:00.000Z');
  });

  test('the key is the label of the month the bounds open, never the UTC day they fall on', () => {
    // startsAt is 31 July in UTC. A key derived by slicing its ISO string — which is
    // what the old `dateParam` did — would say '2026-07-31'.
    const p = billingPeriod(at('2026-08-15T10:00:00+07:00'));
    expect(p.startsAt.toISOString().slice(0, 10)).not.toBe(p.key);
    expect(p.key).toBe('2026-08-01');
  });

  test('December rolls the year over', () => {
    const p = billingPeriod(at('2026-12-20T10:00:00+07:00'));
    expect(p.key).toBe('2026-12-01');
    expect(p.endsAt.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });

  test('an instant is in exactly one period: consecutive periods meet with no gap', () => {
    const july = billingPeriod(at('2026-07-15T10:00:00+07:00'));
    const august = billingPeriod(at('2026-08-15T10:00:00+07:00'));
    expect(july.endsAt.getTime()).toBe(august.startsAt.getTime());
  });
});

describe('previousPeriod', () => {
  test('is the month before the one containing the instant', () => {
    const p = previousPeriod(at('2026-08-01T03:00:00+07:00'));
    expect(p.key).toBe('2026-07-01');
    expect(p.endsAt.toISOString()).toBe('2026-07-31T17:00:00.000Z');
  });

  test('a sweep run in the first WIB hours of 1 January closes December, not November', () => {
    // Under UTC months this instant is still 31 December, so the sweep would have
    // closed November and left December unbilled for another month.
    const p = previousPeriod(at('2027-01-01T00:30:00+07:00'));
    expect(p.key).toBe('2026-12-01');
  });

  test('its end is the current period start, so the two tile', () => {
    const now = at('2026-08-15T10:00:00+07:00');
    expect(previousPeriod(now).endsAt.getTime()).toBe(billingPeriod(now).startsAt.getTime());
  });
});
