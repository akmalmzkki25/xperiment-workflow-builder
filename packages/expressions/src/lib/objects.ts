import { ExpressionEvalError } from '../errors.js';
import { arity, str, MAX_JSON_CHARS, type Fn } from './guards.js';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 64;

interface Lookup {
  found: boolean;
  value: unknown;
}

/** Dotted path; numeric segments index arrays. Mirrors the parser's forbidden set. */
function walk(name: string, root: unknown, path: string): Lookup {
  let cur: unknown = root;
  for (const segment of path.split('.')) {
    if (FORBIDDEN.has(segment)) {
      throw new ExpressionEvalError(`${name}() refuses the path segment '${segment}'`);
    }
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[segment];
  }
  return { found: cur !== undefined, value: cur };
}

/**
 * Key-sorted clone. Output is byte-stable across runs, which the determinism exit
 * criterion depends on — insertion order must never leak into a stored payload.
 */
export function sortDeep(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new ExpressionEvalError('Value nesting is too deep');
  if (Array.isArray(v)) return v.map((x) => sortDeep(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = sortDeep((v as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return v;
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(sortDeep(v)) ?? 'null';
}

export const OBJECT_FUNCTIONS: Record<string, Fn> = {
  get: (args) => {
    // Three arguments, default required: the caller always states the fallback.
    // This is also the escape hatch for a dynamic index, which the parser forbids.
    arity('get', args, 3);
    const found = walk('get', args[0], str('get', args[1], 1));
    return found.found ? found.value : args[2];
  },

  has: (args) => {
    arity('has', args, 2);
    return walk('has', args[0], str('has', args[1], 1)).found;
  },

  jsonParse: (args) => {
    arity('jsonParse', args, 1);
    const raw = str('jsonParse', args[0], 0);
    if (raw.length > MAX_JSON_CHARS) {
      throw new ExpressionEvalError(`jsonParse() input exceeds ${MAX_JSON_CHARS} characters`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ExpressionEvalError('jsonParse() could not parse the value as JSON');
    }
  },

  jsonStringify: (args) => {
    arity('jsonStringify', args, 1);
    return stableStringify(args[0]);
  },

  coalesce: (args) => {
    arity('coalesce', args, 2, 10);
    for (const v of args) {
      if (v !== null && v !== undefined) return v;
    }
    return null;
  },

  // `default` reads like a keyword but the parser only special-cases true/false/null.
  default: (args) => {
    arity('default', args, 2);
    return args[0] ?? args[1];
  },
};
