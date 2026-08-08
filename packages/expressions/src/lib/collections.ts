import { ExpressionEvalError } from '../errors.js';
import { arity, arr, describeValue, obj, str, MAX_ITEMS, type Fn } from './guards.js';
import { stableStringify } from './objects.js';

function capped(name: string, list: unknown[]): unknown[] {
  if (list.length > MAX_ITEMS) {
    throw new ExpressionEvalError(`${name}() refuses a list longer than ${MAX_ITEMS} items`);
  }
  return list;
}

export const COLLECTION_FUNCTIONS: Record<string, Fn> = {
  first: (args) => {
    arity('first', args, 1);
    const list = arr('first', args[0], 0);
    // null, not a throw, so `first(x) ?? fallback` is the idiom.
    return list.length === 0 ? null : list[0];
  },

  last: (args) => {
    arity('last', args, 1);
    const list = arr('last', args[0], 0);
    return list.length === 0 ? null : list[list.length - 1];
  },

  keys: (args) => {
    arity('keys', args, 1);
    // Sorted: insertion order would make downstream output depend on how the
    // upstream connector happened to build the object.
    return Object.keys(obj('keys', args[0], 0)).sort();
  },

  values: (args) => {
    arity('values', args, 1);
    const source = obj('values', args[0], 0);
    return Object.keys(source)
      .sort()
      .map((k) => source[k]);
  },

  unique: (args) => {
    arity('unique', args, 1);
    const list = capped('unique', arr('unique', args[0], 0));
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const v of list) {
      // Primitives compare by value; objects and arrays by their key-sorted shape.
      const key = v !== null && typeof v === 'object' ? `o:${stableStringify(v)}` : `p:${typeof v}:${String(v)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  },

  sort: (args) => {
    arity('sort', args, 1, 2);
    const list = capped('sort', arr('sort', args[0], 0));
    const direction = args.length === 2 ? str('sort', args[1], 1) : 'asc';
    if (direction !== 'asc' && direction !== 'desc') {
      throw new ExpressionEvalError("sort() direction must be 'asc' or 'desc'");
    }
    const allNumbers = list.every((v) => typeof v === 'number' && Number.isFinite(v));
    const allStrings = list.every((v) => typeof v === 'string');
    if (!allNumbers && !allStrings) {
      const offender = list.find((v) => typeof v !== 'number' && typeof v !== 'string');
      throw new ExpressionEvalError(
        `sort() needs a list of all numbers or all strings, found ${describeValue(offender)}`,
      );
    }
    // A NEW array: resolvedParams is written to input_json, so mutating the input
    // would corrupt the recorded trace of what the node actually received.
    const sorted = [...list].sort((a, b) => {
      if (allNumbers) return (a as number) - (b as number);
      // Code-unit order, not localeCompare: locale collation varies with the ICU
      // version, and that would put the determinism criterion at risk.
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    });
    return direction === 'desc' ? sorted.reverse() : sorted;
  },

  reverse: (args) => {
    arity('reverse', args, 1);
    return [...arr('reverse', args[0], 0)].reverse();
  },

  indexOf: (args) => {
    arity('indexOf', args, 2);
    return arr('indexOf', args[0], 0).indexOf(args[1]);
  },

  isEmpty: (args) => {
    arity('isEmpty', args, 1);
    const v = args[0];
    if (v === null || v === undefined) return true;
    if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    // Emptiness is about containers. 0 and false are values.
    return false;
  },
};
