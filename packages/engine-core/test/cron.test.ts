import { describe, expect, test } from 'vitest';
import { nextFireAt } from '../src/index.js';

describe('nextFireAt', () => {
  test('5-field cron advances to the next minute boundary', () => {
    const from = new Date('2026-07-24T10:15:30Z');
    const next = nextFireAt('* * * * *', 'UTC', from);
    expect(next.toISOString()).toBe('2026-07-24T10:16:00.000Z');
  });

  test('6-field seconds cron advances by seconds', () => {
    const from = new Date('2026-07-24T10:15:30.100Z');
    const next = nextFireAt('*/2 * * * * *', 'UTC', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(2000);
  });

  test('timezone is respected (daily 09:00 Jakarta = 02:00 UTC)', () => {
    const from = new Date('2026-07-24T00:00:00Z');
    const next = nextFireAt('0 9 * * *', 'Asia/Jakarta', from);
    expect(next.toISOString()).toBe('2026-07-24T02:00:00.000Z');
  });

  test('invalid cron throws', () => {
    expect(() => nextFireAt('not a cron', 'UTC', new Date())).toThrow();
    expect(() => nextFireAt('99 * * * *', 'UTC', new Date())).toThrow();
  });
});
