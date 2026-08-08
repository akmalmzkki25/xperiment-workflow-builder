import { afterEach, describe, expect, test, vi } from 'vitest';
import { evaluate, parseExpression, ExpressionEvalError, type ExpressionContext } from '../src/index.js';

/** 2026-08-08T03:15Z is Saturday 10:15 in Jakarta — the +07 offset moves the clock visibly. */
const FIXED = Date.parse('2026-08-08T03:15:00.000Z');

function ctxAt(now: number): ExpressionContext {
  return {
    trigger: {
      body: {
        iso: '2026-03-01T22:30:00.000Z',
        bare: '2026-03-01',
        local: '2026-03-01T09:00:00',
        offset: '2026-01-01T00:00:00+07:00',
        sameInstant: '2025-12-31T17:00:00Z',
        junk: 'not a date',
      },
    },
    nodes: {},
    execution: { id: 'exec-1' },
    now,
  };
}

const ctx = ctxAt(FIXED);
const run = (src: string, c: ExpressionContext = ctx) => evaluate(parseExpression(src), c);

afterEach(() => {
  vi.useRealTimers();
});

describe('the evaluation clock', () => {
  test('now() returns the context instant', () => {
    expect(run('now()')).toBe('2026-08-08T03:15:00.000Z');
  });

  test('no date function reads the wall clock', () => {
    // This is the actual regression test for the seam. If any function calls
    // Date.now() directly, moving the system clock moves the answer.
    const before = run('now()');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'));
    expect(run('now()')).toBe(before);
    expect(run('today()')).toBe('2026-08-08');
  });

  test('two now() calls in one expression agree, even across a clock change', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'));
    expect(run('now() == now()')).toBe(true);
  });
});

describe('today and parseDate', () => {
  test('today() is the Jakarta calendar date, not the UTC one', () => {
    // 20:00 UTC on the 7th is already 03:00 on the 8th in Jakarta.
    const late = ctxAt(Date.parse('2026-08-07T20:00:00.000Z'));
    expect(run('today()', late)).toBe('2026-08-08');
    expect(run("today('UTC')", late)).toBe('2026-08-07');
  });

  test('parseDate reads a bare date as Jakarta midnight', () => {
    expect(run('parseDate(trigger.body.bare)')).toBe('2026-02-28T17:00:00.000Z');
    expect(run('parseDate(trigger.body.local)')).toBe('2026-03-01T02:00:00.000Z');
  });

  test('parseDate normalises a value that already carries a zone', () => {
    expect(run('parseDate(trigger.body.iso)')).toBe('2026-03-01T22:30:00.000Z');
    expect(run('parseDate(trigger.body.offset)')).toBe('2025-12-31T17:00:00.000Z');
  });

  test('parseDate rejects garbage instead of returning an invalid date', () => {
    expect(() => run('parseDate(trigger.body.junk)')).toThrow(ExpressionEvalError);
    expect(() => run("parseDate('2026-13-45')")).toThrow(ExpressionEvalError);
  });
});

describe('formatDate', () => {
  test('honours the pattern vocabulary and defaults to Jakarta', () => {
    expect(run("formatDate(trigger.body.iso, 'dd/MM/yyyy')")).toBe('02/03/2026');
    expect(run("formatDate(trigger.body.iso, 'yyyy-MM-dd HH:mm:ss')")).toBe('2026-03-02 05:30:00');
    expect(run("formatDate(now(), 'yyyy-MM-dd')")).toBe('2026-08-08');
  });

  test('honours an explicit timezone', () => {
    expect(run("formatDate(trigger.body.iso, 'yyyy-MM-dd HH:mm', 'UTC')")).toBe('2026-03-01 22:30');
    expect(run("formatDate(trigger.body.iso, 'HH:mm', 'Asia/Makassar')")).toBe('06:30');
  });

  test('midnight formats as 00, not 24', () => {
    // ICU's default hourCycle reports midnight as 24, which is the classic Node date bug.
    expect(run("formatDate(trigger.body.bare, 'HH:mm')")).toBe('00:00');
  });

  test('supports quoted literals', () => {
    expect(run('formatDate(trigger.body.iso, "dd/MM/yyyy \'pukul\' HH:mm")')).toBe('02/03/2026 pukul 05:30');
  });

  test('rejects an unsupported pattern character', () => {
    expect(() => run("formatDate(trigger.body.iso, 'MMMM')")).toThrow(ExpressionEvalError);
    expect(() => run("formatDate(trigger.body.iso, 'yyyy%MM')")).toThrow(ExpressionEvalError);
  });

  test('rejects an unknown timezone instead of falling back to UTC', () => {
    // A silent UTC fallback would put every Indonesian timestamp seven hours out.
    expect(() => run("formatDate(trigger.body.iso, 'yyyy', 'Mars/Olympus')")).toThrow(ExpressionEvalError);
  });
});

describe('date arithmetic', () => {
  test('addDays adds calendar days; addHours and addMinutes add exact time', () => {
    expect(run("formatDate(addDays(trigger.body.bare, 1), 'yyyy-MM-dd')")).toBe('2026-03-02');
    expect(run("formatDate(addDays(trigger.body.bare, 0 - 1), 'yyyy-MM-dd')")).toBe('2026-02-28');
    expect(run('addHours(trigger.body.iso, 2)')).toBe('2026-03-02T00:30:00.000Z');
    expect(run('addMinutes(trigger.body.iso, 45)')).toBe('2026-03-01T23:15:00.000Z');
  });

  test('addDays crosses a month and a year boundary', () => {
    expect(run("formatDate(addDays('2026-12-31', 1), 'yyyy-MM-dd')")).toBe('2027-01-01');
    expect(run("formatDate(addDays('2028-02-28', 1), 'yyyy-MM-dd')")).toBe('2028-02-29');
  });

  test('addDays refuses an absurd offset', () => {
    expect(() => run("addDays(trigger.body.bare, 99999999)")).toThrow(ExpressionEvalError);
  });

  test('diffDays counts calendar days and is signed', () => {
    expect(run("diffDays('2026-03-05', '2026-03-01')")).toBe(4);
    expect(run("diffDays('2026-03-01', '2026-03-05')")).toBe(-4);
    // Two instants 40 minutes apart across a Jakarta midnight are one calendar day.
    expect(run("diffDays('2026-03-01T17:10:00Z', '2026-03-01T16:50:00Z')")).toBe(1);
  });

  test('diffHours truncates toward zero', () => {
    expect(run("diffHours('2026-03-01T12:59:00Z', '2026-03-01T10:00:00Z')")).toBe(2);
    expect(run("diffHours('2026-03-01T10:00:00Z', '2026-03-01T12:59:00Z')")).toBe(-2);
  });

  test('startOfDay and endOfDay bracket the Jakarta day', () => {
    expect(run('startOfDay(trigger.body.iso)')).toBe('2026-03-01T17:00:00.000Z');
    expect(run('endOfDay(trigger.body.iso)')).toBe('2026-03-02T16:59:59.999Z');
    expect(run("startOfDay(trigger.body.iso, 'UTC')")).toBe('2026-03-01T00:00:00.000Z');
  });

  test('dayOfWeek is ISO: Monday is 1 and Sunday is 7', () => {
    expect(run("dayOfWeek('2026-08-08')")).toBe(6);
    expect(run("dayOfWeek('2026-08-09')")).toBe(7);
    expect(run("dayOfWeek('2026-08-10')")).toBe(1);
  });

  test('isBefore and isAfter compare instants, not strings', () => {
    // Same instant written two ways. A string comparison would say the first is later.
    expect(run('isAfter(trigger.body.offset, trigger.body.sameInstant)')).toBe(false);
    expect(run('isBefore(trigger.body.offset, trigger.body.sameInstant)')).toBe(false);
    expect(run("isBefore('2026-01-01', '2026-01-02')")).toBe(true);
    expect(run("isAfter('2026-01-02', '2026-01-01')")).toBe(true);
  });

  test('every date function type-checks its arguments', () => {
    expect(() => run('addDays(trigger.body.bare)')).toThrow(ExpressionEvalError);
    expect(() => run("addDays(trigger.body.bare, 'one')")).toThrow(ExpressionEvalError);
    expect(() => run('formatDate(trigger.body.iso, 42)')).toThrow(ExpressionEvalError);
    expect(() => run('dayOfWeek(42)')).toThrow(ExpressionEvalError);
  });
});
