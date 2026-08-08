import { describe, expect, test } from 'vitest';
import {
  evaluate,
  parseExpression,
  resolveTemplate,
  ExpressionEvalError,
  ExpressionParseError,
  type ExpressionContext,
} from '../src/index.js';

const ctx: ExpressionContext = {
  trigger: {
    body: {
      plain: { a: 1 },
      poisoned: JSON.parse('{"__proto__":{"x":1},"keep":2}') as unknown,
      dupes: JSON.parse('[{"__proto__":{"x":1},"a":1},{"a":1}]') as unknown,
      pgTimestamp: '2026-01-15 10:30:00.123456',
      longA: 'a'.repeat(2000),
      pad1k: 'x'.repeat(1000),
      manyLong: Array.from({ length: 1000 }, () => 'y'.repeat(1000)),
      big: Array.from({ length: 200_000 }, (_, i) => i),
    },
  },
  nodes: {},
  execution: { id: 'exec-1' },
  now: Date.parse('2026-08-08T03:15:00.000Z'),
};

const run = (src: string) => evaluate(parseExpression(src), ctx);

describe('a data-supplied __proto__ key is data, not a setter', () => {
  test('jsonStringify keeps a __proto__ key instead of dropping the subtree', () => {
    // Assigning a computed key onto a fresh {} invokes the inherited __proto__ setter,
    // so no own property is created and the subtree silently vanishes.
    const out = run('jsonStringify(trigger.body.poisoned)') as string;
    expect(out).toContain('keep');
    expect(out).toContain('__proto__');
  });

  test('unique does not collide two objects that differ only by a __proto__ key', () => {
    // unique() keys on stableStringify, so a dropped subtree makes distinct rows identical.
    expect(run('length(trigger.body.dupes)')).toBe(2);
    expect(run('length(unique(trigger.body.dupes))')).toBe(2);
  });

  test('resolveTemplate preserves a __proto__ key in a parameter object', () => {
    const resolved = resolveTemplate(JSON.parse('{"__proto__":{"a":1},"ok":"x"}') as unknown, ctx);
    expect(Object.keys(resolved as object).sort()).toEqual(['__proto__', 'ok']);
  });
});

describe('only own properties are readable', () => {
  test('a chain never reaches an inherited member', () => {
    // A Function reaching a connector breaks the closed value space, and JSON.stringify
    // drops the key entirely on the way into input_json.
    expect(run('trigger.body.plain.toString')).toBeNull();
    expect(run('trigger.body.plain.valueOf')).toBeNull();
    expect(run('trigger.body.plain.hasOwnProperty')).toBeNull();
  });

  test('has reports false for an inherited member', () => {
    expect(run("has(trigger.body.plain, 'toString')")).toBe(false);
    expect(run("has(trigger.body.plain, 'a')")).toBe(true);
  });

  test('get returns the default rather than an inherited function', () => {
    expect(run("get(trigger.body.plain, 'valueOf', 'none')")).toBe('none');
    expect(run("get(trigger.body.plain, 'a', 'none')")).toBe(1);
  });

  test('an array length is still readable — it is an own property', () => {
    expect(run('trigger.body.manyLong.length')).toBe(1000);
  });
});

describe('parseDate anchors every value it accepts', () => {
  test('reads a postgres timestamp with microseconds in Jakarta', () => {
    // The Date.parse fallback read this in the HOST timezone, so the same workflow gave
    // a different answer on a dev box than in the container.
    // Microseconds truncate to milliseconds; the offset is Jakarta's, not the host's.
    expect(run('parseDate(trigger.body.pgTimestamp)')).toBe('2026-01-15T03:30:00.123Z');
  });

  test('refuses a zoneless format it cannot anchor', () => {
    expect(() => run("parseDate('2026/01/15')")).toThrow(ExpressionEvalError);
    expect(() => run("parseDate('Jan 15, 2026 10:30')")).toThrow(ExpressionEvalError);
    expect(() => run("parseDate('2026-1-5')")).toThrow(ExpressionEvalError);
  });

  test('still accepts anything carrying an explicit zone', () => {
    expect(run("parseDate('2026-01-15T10:30:00Z')")).toBe('2026-01-15T10:30:00.000Z');
    expect(run("parseDate('2026-01-15T10:30:00+07:00')")).toBe('2026-01-15T03:30:00.000Z');
  });

  test('a two-digit year is not mapped into the 1900s', () => {
    // Date.UTC maps a year argument of 0-99 to 1900+y.
    expect(run("formatDate('0026-02-10', 'yyyy-MM-dd')")).toBe('0026-02-10');
  });
});

describe('daylight saving gaps', () => {
  const cases = [
    ['2026-09-06', 'America/Santiago'],
    ['2026-03-08', 'America/New_York'],
    ['2026-10-04', 'Australia/Lord_Howe'],
    ['2026-03-01', 'Asia/Jakarta'],
  ] as const;

  test('startOfDay lands on the requested calendar day', () => {
    for (const [date, tz] of cases) {
      const start = run(`startOfDay('${date}', '${tz}')`) as string;
      expect(run(`formatDate('${start}', 'yyyy-MM-dd', '${tz}')`), `${date} in ${tz}`).toBe(date);
    }
  });

  test('endOfDay stays inside the same calendar day', () => {
    for (const [date, tz] of cases) {
      const end = run(`endOfDay('${date}', '${tz}')`) as string;
      expect(run(`formatDate('${end}', 'yyyy-MM-dd', '${tz}')`), `${date} in ${tz}`).toBe(date);
    }
  });

  test('addDays advances the calendar date', () => {
    expect(run("formatDate(addDays('2026-09-05', 1, 'America/Santiago'), 'yyyy-MM-dd', 'America/Santiago')")).toBe(
      '2026-09-06',
    );
    expect(run("formatDate(addDays('2026-03-07', 1, 'America/New_York'), 'yyyy-MM-dd', 'America/New_York')")).toBe(
      '2026-03-08',
    );
  });
});

describe('type discipline and allocation caps', () => {
  test('toNumber refuses null, booleans, arrays and objects', () => {
    // A missing amount becoming 0 lands on an invoice.
    expect(() => run('toNumber(trigger.body.missing)')).toThrow(ExpressionEvalError);
    expect(() => run('toNumber(true)')).toThrow(ExpressionEvalError);
    expect(() => run('toNumber(trigger.body.plain)')).toThrow(ExpressionEvalError);
    expect(() => run("toNumber('0x1f')")).toThrow(ExpressionEvalError);
    expect(() => run("toNumber('')")).toThrow(ExpressionEvalError);
    expect(run("toNumber('42')")).toBe(42);
    expect(run("toNumber('-3.5')")).toBe(-3.5);
    expect(run('toNumber(7)')).toBe(7);
  });

  test('replace refuses an expansion beyond the output cap', () => {
    // 2000 occurrences x 1000 chars is 2 million characters from a small input.
    expect(() => run('replace(trigger.body.longA, "a", trigger.body.pad1k)')).toThrow(ExpressionEvalError);
    expect(run('replace("a-b", "-", "+")')).toBe('a+b');
  });

  test('join refuses an output beyond the cap', () => {
    expect(() => run('join(trigger.body.manyLong, "")')).toThrow(ExpressionEvalError);
  });

  test('min and max handle a very long list without overflowing the stack', () => {
    // Spreading 131k arguments into Math.min is a RangeError, and the threshold is
    // stack-size dependent — the same expression could pass on one machine and fail
    // on another, which is a determinism hazard on top of the crash.
    expect(run('min(trigger.body.big)')).toBe(0);
    expect(run('max(trigger.body.big)')).toBe(199_999);
  });

  test('unique and jsonParse enforce their caps', () => {
    expect(() => run('unique(trigger.body.big)')).toThrow(ExpressionEvalError);
    expect(() => run('jsonParse(trigger.body.longA)')).toThrow(ExpressionEvalError);
  });

  test('a deeply nested expression is a parse error, not a stack overflow', () => {
    const deep = `${'('.repeat(600)}1${')'.repeat(600)}`;
    expect(() => parseExpression(deep)).toThrow(ExpressionParseError);
  });
});
