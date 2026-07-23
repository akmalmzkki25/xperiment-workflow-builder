import { ExpressionEvalError } from './errors.js';

type Fn = (args: unknown[]) => unknown;

function requireArity(name: string, args: unknown[], n: number): void {
  if (args.length !== n) {
    throw new ExpressionEvalError(`${name}() expects ${n} argument(s), got ${args.length}`);
  }
}

function requireString(name: string, v: unknown): string {
  if (typeof v !== 'string') {
    throw new ExpressionEvalError(`${name}() expects a string, got ${typeof v}`);
  }
  return v;
}

export const FUNCTIONS: Record<string, Fn> = {
  lower: (args) => {
    requireArity('lower', args, 1);
    return requireString('lower', args[0]).toLowerCase();
  },
  upper: (args) => {
    requireArity('upper', args, 1);
    return requireString('upper', args[0]).toUpperCase();
  },
  trim: (args) => {
    requireArity('trim', args, 1);
    return requireString('trim', args[0]).trim();
  },
  length: (args) => {
    requireArity('length', args, 1);
    const v = args[0];
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    throw new ExpressionEvalError(`length() expects a string or array, got ${typeof v}`);
  },
  toNumber: (args) => {
    requireArity('toNumber', args, 1);
    const n = Number(args[0]);
    if (Number.isNaN(n)) throw new ExpressionEvalError('toNumber() could not convert value to a number');
    return n;
  },
  toString: (args: unknown[]) => {
    requireArity('toString', args, 1);
    const v = args[0];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  },
};

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS));
