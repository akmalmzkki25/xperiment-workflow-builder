import { ExpressionEvalError } from '../errors.js';
import { arity, arr, describeValue, int, str, MAX_PAD, type Fn } from './guards.js';

export const STRING_FUNCTIONS: Record<string, Fn> = {
  split: (args) => {
    arity('split', args, 2);
    const s = str('split', args[0], 0);
    const sep = str('split', args[1], 1);
    if (sep === '') throw new ExpressionEvalError('split() separator must not be empty');
    return s.split(sep);
  },

  join: (args) => {
    arity('join', args, 2);
    const list = arr('join', args[0], 0);
    const sep = str('join', args[1], 1);
    return list
      .map((v, i) => {
        if (typeof v === 'string') return v;
        // Never let an object become '[object Object]' silently.
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
        throw new ExpressionEvalError(
          `join() element ${i + 1} expects a string or a finite number, got ${describeValue(v)}`,
        );
      })
      .join(sep);
  },

  replace: (args) => {
    arity('replace', args, 3);
    const s = str('replace', args[0], 0);
    const find = str('replace', args[1], 1);
    const to = str('replace', args[2], 2);
    if (find === '') throw new ExpressionEvalError('replace() search text must not be empty');
    // split/join replaces every occurrence without needing a regex.
    return s.split(find).join(to);
  },

  slice: (args) => {
    arity('slice', args, 2, 3);
    const v = args[0];
    const start = int('slice', args[1], 1);
    const end = args.length === 3 ? int('slice', args[2], 2) : undefined;
    if (typeof v === 'string' || Array.isArray(v)) {
      return end === undefined ? v.slice(start) : v.slice(start, end);
    }
    throw new ExpressionEvalError(`slice() argument 1 expects a string or an array, got ${describeValue(v)}`);
  },

  contains: (args) => {
    arity('contains', args, 2);
    const haystack = args[0];
    if (typeof haystack === 'string') return haystack.includes(str('contains', args[1], 1));
    // Strict membership on arrays: contains(prices, '1500') is false.
    if (Array.isArray(haystack)) return haystack.includes(args[1]);
    throw new ExpressionEvalError(
      `contains() argument 1 expects a string or an array, got ${describeValue(haystack)}`,
    );
  },

  startsWith: (args) => {
    arity('startsWith', args, 2);
    return str('startsWith', args[0], 0).startsWith(str('startsWith', args[1], 1));
  },

  endsWith: (args) => {
    arity('endsWith', args, 2);
    return str('endsWith', args[0], 0).endsWith(str('endsWith', args[1], 1));
  },

  padStart: (args) => {
    arity('padStart', args, 2, 3);
    const s = str('padStart', args[0], 0);
    const width = padWidth('padStart', args[1]);
    return s.padStart(width, args.length === 3 ? str('padStart', args[2], 2) : ' ');
  },

  padEnd: (args) => {
    arity('padEnd', args, 2, 3);
    const s = str('padEnd', args[0], 0);
    const width = padWidth('padEnd', args[1]);
    return s.padEnd(width, args.length === 3 ? str('padEnd', args[2], 2) : ' ');
  },
};

function padWidth(name: string, v: unknown): number {
  const width = int(name, v, 1);
  if (width < 0 || width > MAX_PAD) {
    throw new ExpressionEvalError(`${name}() target length must be between 0 and ${MAX_PAD}`);
  }
  return width;
}
