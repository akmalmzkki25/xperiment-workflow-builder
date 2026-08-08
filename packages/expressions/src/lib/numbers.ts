import { ExpressionEvalError } from '../errors.js';
import { arity, arr, describeValue, finite, int, num, type Fn } from './guards.js';

const MAX_DECIMALS = 10;

/**
 * Half-away-from-zero, deliberately not JS's Math.round.
 *
 * Math.round(-2.5) is -2 — it rounds toward +Infinity, so a refund and a charge of
 * the same magnitude round differently. That asymmetry is not acceptable for money.
 */
function roundHalfAwayFromZero(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = n * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

/** min/max take EITHER one array OR two-or-more scalars. */
function numericList(name: string, args: unknown[]): number[] {
  if (args.length === 1) {
    const list = arr(name, args[0], 0);
    if (list.length === 0) throw new ExpressionEvalError(`${name}() of an empty list has no answer`);
    return list.map((v, i) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ExpressionEvalError(`${name}() element ${i + 1} expects a finite number, got ${describeValue(v)}`);
      }
      return v;
    });
  }
  return args.map((v, i) => num(name, v, i));
}

function total(name: string, list: unknown[]): number {
  let sum = 0;
  for (const [i, v] of list.entries()) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ExpressionEvalError(`${name}() element ${i + 1} expects a finite number, got ${describeValue(v)}`);
    }
    sum += v;
  }
  return finite(name, sum);
}

export const NUMBER_FUNCTIONS: Record<string, Fn> = {
  round: (args) => {
    arity('round', args, 1, 2);
    const n = num('round', args[0], 0);
    const dp = args.length === 2 ? int('round', args[1], 1) : 0;
    if (dp < 0 || dp > MAX_DECIMALS) {
      throw new ExpressionEvalError(`round() decimal places must be between 0 and ${MAX_DECIMALS}`);
    }
    return finite('round', roundHalfAwayFromZero(n, dp));
  },

  floor: (args) => {
    arity('floor', args, 1);
    return Math.floor(num('floor', args[0], 0));
  },

  ceil: (args) => {
    arity('ceil', args, 1);
    return Math.ceil(num('ceil', args[0], 0));
  },

  abs: (args) => {
    arity('abs', args, 1);
    return Math.abs(num('abs', args[0], 0));
  },

  min: (args) => {
    arity('min', args, 1, 10);
    return Math.min(...numericList('min', args));
  },

  max: (args) => {
    arity('max', args, 1, 10);
    return Math.max(...numericList('max', args));
  },

  sum: (args) => {
    arity('sum', args, 1);
    // Zero IS the identity for addition, so an empty list has an honest answer here.
    return total('sum', arr('sum', args[0], 0));
  },

  avg: (args) => {
    arity('avg', args, 1);
    const list = arr('avg', args[0], 0);
    // No identity for a mean. Returning 0 would be a lie that ends up on an invoice.
    if (list.length === 0) throw new ExpressionEvalError('avg() of an empty list has no answer');
    return finite('avg', total('avg', list) / list.length);
  },

  toFixed: (args) => {
    arity('toFixed', args, 2);
    const n = num('toFixed', args[0], 0);
    const dp = int('toFixed', args[1], 1);
    if (dp < 0 || dp > 20) throw new ExpressionEvalError('toFixed() decimal places must be between 0 and 20');
    // Returns a STRING. That is the point of it.
    return n.toFixed(dp);
  },

  formatIDR: (args) => {
    arity('formatIDR', args, 1);
    const n = num('formatIDR', args[0], 0);
    // Rupiah has no minor unit in practice, so no fraction digits.
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n);
  },
};
