/**
 * What a billing period is.
 *
 * The old definition was the UTC calendar month, which put a run at 03:00 WIB on the
 * first of the month into the *previous* month's invoice — while scheduling, elsewhere
 * in the product, already defaulted to Asia/Jakarta.
 *
 * A period carries three values because one Date was doing two jobs: labelling a DATE
 * column and bounding a timestamptz range. Those are the same value only in UTC.
 */

/**
 * The product is Indonesia-first, and the scheduler already hardcodes this zone. Making
 * it per-workspace is a real feature with its own settings surface and migration; it is
 * deliberately not smuggled in here.
 */
export const BILLING_TZ = 'Asia/Jakarta';

export interface BillingPeriod {
  /** `YYYY-MM-DD` — the DATE key of `workspace_usage_counters` and `invoices`. */
  key: string;
  /** The next month's key: `invoices.period_end`, a label rather than a bound. */
  endKey: string;
  /** First instant of the month in {@link BILLING_TZ}. */
  startsAt: Date;
  /** First instant of the next month, exclusive. */
  endsAt: Date;
}

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: BILLING_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The wall-clock fields an observer in BILLING_TZ would read off `at`. */
function wallClock(at: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const found: Record<string, number> = {};
  for (const p of PARTS.formatToParts(at)) {
    if (p.type !== 'literal') found[p.type] = Number(p.value);
  }
  return {
    year: found['year'] ?? 0,
    month: found['month'] ?? 1,
    day: found['day'] ?? 1,
    hour: found['hour'] ?? 0,
    minute: found['minute'] ?? 0,
    second: found['second'] ?? 0,
  };
}

/**
 * The instant at which the given wall-clock reading occurs in BILLING_TZ.
 *
 * Solved rather than computed from a fixed +7: the offset is read back from the zone, so
 * changing BILLING_TZ to a zone with a different or seasonal offset keeps working. One
 * correction is enough for a month boundary, which is never within an hour of a
 * transition.
 */
function instantOf(year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day);
  const seen = wallClock(new Date(guess));
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return new Date(guess - (seenAsUtc - guess));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function monthPeriod(year: number, month: number): BillingPeriod {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    key: `${year}-${pad(month)}-01`,
    endKey: `${nextYear}-${pad(nextMonth)}-01`,
    startsAt: instantOf(year, month, 1),
    endsAt: instantOf(nextYear, nextMonth, 1),
  };
}

/** The period containing `now`. */
export function billingPeriod(now: Date): BillingPeriod {
  const { year, month } = wallClock(now);
  return monthPeriod(year, month);
}

/** The period before the one containing `now` — the one an invoice sweep may close. */
export function previousPeriod(now: Date): BillingPeriod {
  const { year, month } = wallClock(now);
  return month === 1 ? monthPeriod(year - 1, 12) : monthPeriod(year, month - 1);
}
