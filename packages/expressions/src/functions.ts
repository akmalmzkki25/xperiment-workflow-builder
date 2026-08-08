import { ExpressionEvalError } from './errors.js';
import { COLLECTION_FUNCTIONS } from './lib/collections.js';
import { DATE_FUNCTIONS } from './lib/dates.js';
import { arity, str, type Fn } from './lib/guards.js';
import { NUMBER_FUNCTIONS } from './lib/numbers.js';
import { OBJECT_FUNCTIONS } from './lib/objects.js';
import { STRING_FUNCTIONS } from './lib/strings.js';

export type { Fn } from './lib/guards.js';

/**
 * There are no lambdas, so map/filter/reduce are not possible here and are not
 * missing by oversight: every Fn receives arguments that are already evaluated,
 * and the Ast union has no function-value node. Array work happens at the graph
 * level instead — core.filter, core.sort, core.aggregate.
 */
/** Deliberately excludes hex, Infinity and the empty string, all of which Number() accepts. */
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const CORE_FUNCTIONS: Record<string, Fn> = {
  lower: (args) => {
    arity('lower', args, 1);
    return str('lower', args[0], 0).toLowerCase();
  },
  upper: (args) => {
    arity('upper', args, 1);
    return str('upper', args[0], 0).toUpperCase();
  },
  trim: (args) => {
    arity('trim', args, 1);
    return str('trim', args[0], 0).trim();
  },
  length: (args) => {
    arity('length', args, 1);
    const v = args[0];
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    throw new ExpressionEvalError(`length() expects a string or array, got ${typeof v}`);
  },
  toNumber: (args) => {
    arity('toNumber', args, 1);
    const v = args[0];
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ExpressionEvalError('toNumber() expects a finite number');
      return v;
    }
    // Number() coerces null to 0, true to 1 and [] to 0. A missing amount silently
    // becoming zero lands on an invoice, so only a real decimal string is accepted.
    const text = typeof v === 'string' ? v.trim() : '';
    if (text === '' || !DECIMAL_LITERAL.test(text)) {
      throw new ExpressionEvalError('toNumber() expects a number or a decimal string');
    }
    const n = Number(text);
    // Finite, not merely non-NaN: Number('1e999') is Infinity, and letting that through
    // would reintroduce the value the arithmetic guards exist to keep out.
    if (!Number.isFinite(n)) throw new ExpressionEvalError('toNumber() could not convert value to a finite number');
    return n;
  },
  // Annotated because `toString` collides with Object.prototype.toString, so the
  // Record<string, Fn> contextual type does not reach this one property.
  toString: (args: unknown[]) => {
    arity('toString', args, 1);
    const v = args[0];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  },
};

export const FUNCTIONS: Record<string, Fn> = {
  ...CORE_FUNCTIONS,
  ...STRING_FUNCTIONS,
  ...NUMBER_FUNCTIONS,
  ...COLLECTION_FUNCTIONS,
  ...OBJECT_FUNCTIONS,
  ...DATE_FUNCTIONS,
};

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS));
