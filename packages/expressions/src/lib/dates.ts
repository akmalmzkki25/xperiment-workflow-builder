import { ExpressionEvalError } from '../errors.js';
import { arity, int, str, type Fn } from './guards.js';

/**
 * Schedules already default to Jakarta in the API and the scheduler. Dates read in an
 * expression must agree with them, or a merchant's "today" starts seven hours late.
 */
export const DEFAULT_TZ = 'Asia/Jakarta';

const MAX_OFFSET_DAYS = 36_500;
const MAX_OFFSET_UNITS = MAX_OFFSET_DAYS * 24 * 60;

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(name: string, tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      // Explicit: ICU's default reports midnight as hour 24.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
  } catch {
    // Never fall back to UTC. That would put every Indonesian timestamp seven hours out
    // and the workflow would keep running as if nothing were wrong.
    throw new ExpressionEvalError(`${name}() does not know the timezone '${tz}'`);
  }
  formatters.set(tz, fmt);
  return fmt;
}

/** Always en-US and always formatToParts — `format()` output is locale-dependent. */
function partsIn(name: string, instant: number, tz: string): Parts {
  const raw = formatterFor(name, tz).formatToParts(new Date(instant));
  const pick = (type: string): string => raw.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: pick('weekday'),
  };
}

/** Offset of `tz` at `instant`, in milliseconds. */
function offsetAt(name: string, instant: number, tz: string): number {
  const p = partsIn(name, instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Reads wall-clock components in `tz` as an instant. Two passes settle a DST edge. */
function zonedToInstant(
  name: string,
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const firstPass = guess - offsetAt(name, guess, tz);
  return guess - offsetAt(name, firstPass, tz);
}

const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BARE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

function assertCalendar(name: string, y: number, mo: number, d: number): void {
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || d < 1 || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new ExpressionEvalError(`${name}() received a value that is not a real calendar date`);
  }
}

/**
 * A value without a zone is read in `tz`, not UTC — that is the entire point of the
 * Jakarta default. The message never echoes the value: a date field can hold PII.
 */
function toInstant(name: string, v: unknown, pos: number, tz: string): number {
  const s = str(name, v, pos);

  const dateOnly = BARE_DATE.exec(s);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    assertCalendar(name, Number(y), Number(mo), Number(d));
    return zonedToInstant(name, tz, Number(y), Number(mo), Number(d), 0, 0, 0, 0);
  }

  const local = BARE_DATETIME.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, sec, frac] = local;
    assertCalendar(name, Number(y), Number(mo), Number(d));
    return zonedToInstant(
      name,
      tz,
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      Number(sec ?? '0'),
      Number((frac ?? '0').padEnd(3, '0')),
    );
  }

  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) throw new ExpressionEvalError(`${name}() could not read the value as a date`);
  return parsed;
}

const TOKENS = ['yyyy', 'MM', 'dd', 'HH', 'mm', 'ss'];
/** Closed vocabulary. A closed set is what makes this implementable on formatToParts. */
const LITERAL_CHARS = new Set([' ', '-', '/', ':', '.', ',']);

function tokenValue(token: string, p: Parts): string {
  switch (token) {
    case 'yyyy':
      return String(p.year).padStart(4, '0');
    case 'MM':
      return String(p.month).padStart(2, '0');
    case 'dd':
      return String(p.day).padStart(2, '0');
    case 'HH':
      return String(p.hour).padStart(2, '0');
    case 'mm':
      return String(p.minute).padStart(2, '0');
    default:
      return String(p.second).padStart(2, '0');
  }
}

function render(pattern: string, p: Parts): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "'") {
      const end = pattern.indexOf("'", i + 1);
      if (end === -1) throw new ExpressionEvalError('formatDate() has an unterminated quoted literal');
      out += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    const ch = pattern[i]!;
    if (/[A-Za-z]/.test(ch)) {
      // Consume the WHOLE run of one letter. Matching greedily token-by-token would
      // let 'MMMM' quietly render as '0303' instead of being refused.
      let j = i;
      while (j < pattern.length && pattern[j] === ch) j += 1;
      const run = pattern.slice(i, j);
      if (TOKENS.includes(run) || run === 'T') {
        out += run === 'T' ? 'T' : tokenValue(run, p);
        i = j;
        continue;
      }
      throw new ExpressionEvalError(
        `formatDate() does not support the pattern token '${run}' — use yyyy MM dd HH mm ss or a quoted literal`,
      );
    }
    if (!LITERAL_CHARS.has(ch)) {
      throw new ExpressionEvalError(
        `formatDate() does not support the pattern character '${ch}' — use yyyy MM dd HH mm ss or a quoted literal`,
      );
    }
    out += ch;
    i += 1;
  }
  return out;
}

function tzArg(name: string, args: unknown[], pos: number): string {
  return args.length > pos ? str(name, args[pos], pos) : DEFAULT_TZ;
}

function iso(instant: number): string {
  if (!Number.isFinite(instant)) throw new ExpressionEvalError('Date is out of range');
  return new Date(instant).toISOString();
}

function shift(name: string, args: unknown[], unitMs: number): string {
  arity(name, args, 2);
  const base = toInstant(name, args[0], 0, DEFAULT_TZ);
  const amount = int(name, args[1], 1);
  if (Math.abs(amount) > MAX_OFFSET_UNITS) {
    throw new ExpressionEvalError(`${name}() offset is out of range`);
  }
  return iso(base + amount * unitMs);
}

const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export const DATE_FUNCTIONS: Record<string, Fn> = {
  now: (args, ctx) => {
    arity('now', args, 0);
    return iso(ctx.now);
  },

  today: (args, ctx) => {
    arity('today', args, 0, 1);
    return render('yyyy-MM-dd', partsIn('today', ctx.now, tzArg('today', args, 0)));
  },

  parseDate: (args) => {
    arity('parseDate', args, 1, 2);
    return iso(toInstant('parseDate', args[0], 0, tzArg('parseDate', args, 1)));
  },

  formatDate: (args) => {
    arity('formatDate', args, 2, 3);
    const tz = tzArg('formatDate', args, 2);
    const instant = toInstant('formatDate', args[0], 0, tz);
    return render(str('formatDate', args[1], 1), partsIn('formatDate', instant, tz));
  },

  addDays: (args) => {
    arity('addDays', args, 2, 3);
    const tz = tzArg('addDays', args, 2);
    const amount = int('addDays', args[1], 1);
    if (Math.abs(amount) > MAX_OFFSET_DAYS) throw new ExpressionEvalError('addDays() offset is out of range');
    const p = partsIn('addDays', toInstant('addDays', args[0], 0, tz), tz);
    // Calendar days, so the wall-clock time survives a DST shift. Jakarta has none,
    // but an explicit tz argument lets zones that do have one in.
    return iso(zonedToInstant('addDays', tz, p.year, p.month, p.day + amount, p.hour, p.minute, p.second, 0));
  },

  addHours: (args) => shift('addHours', args, 3_600_000),
  addMinutes: (args) => shift('addMinutes', args, 60_000),

  diffDays: (args) => {
    arity('diffDays', args, 2, 3);
    const tz = tzArg('diffDays', args, 2);
    const a = partsIn('diffDays', toInstant('diffDays', args[0], 0, tz), tz);
    const b = partsIn('diffDays', toInstant('diffDays', args[1], 1, tz), tz);
    const dayA = Date.UTC(a.year, a.month - 1, a.day);
    const dayB = Date.UTC(b.year, b.month - 1, b.day);
    return Math.round((dayA - dayB) / 86_400_000);
  },

  diffHours: (args) => {
    arity('diffHours', args, 2);
    const a = toInstant('diffHours', args[0], 0, DEFAULT_TZ);
    const b = toInstant('diffHours', args[1], 1, DEFAULT_TZ);
    return Math.trunc((a - b) / 3_600_000);
  },

  startOfDay: (args) => {
    arity('startOfDay', args, 1, 2);
    const tz = tzArg('startOfDay', args, 1);
    const p = partsIn('startOfDay', toInstant('startOfDay', args[0], 0, tz), tz);
    return iso(zonedToInstant('startOfDay', tz, p.year, p.month, p.day, 0, 0, 0, 0));
  },

  endOfDay: (args) => {
    arity('endOfDay', args, 1, 2);
    const tz = tzArg('endOfDay', args, 1);
    const p = partsIn('endOfDay', toInstant('endOfDay', args[0], 0, tz), tz);
    return iso(zonedToInstant('endOfDay', tz, p.year, p.month, p.day, 23, 59, 59, 999));
  },

  dayOfWeek: (args) => {
    arity('dayOfWeek', args, 1, 2);
    const tz = tzArg('dayOfWeek', args, 1);
    const p = partsIn('dayOfWeek', toInstant('dayOfWeek', args[0], 0, tz), tz);
    // ISO-8601: Monday is 1. Not JS's Sunday-is-0, because a business week starts Monday.
    const day = ISO_WEEKDAY[p.weekday];
    if (day === undefined) throw new ExpressionEvalError('dayOfWeek() could not determine the weekday');
    return day;
  },

  isBefore: (args) => {
    arity('isBefore', args, 2);
    return toInstant('isBefore', args[0], 0, DEFAULT_TZ) < toInstant('isBefore', args[1], 1, DEFAULT_TZ);
  },

  isAfter: (args) => {
    arity('isAfter', args, 2);
    return toInstant('isAfter', args[0], 0, DEFAULT_TZ) > toInstant('isAfter', args[1], 1, DEFAULT_TZ);
  },
};
