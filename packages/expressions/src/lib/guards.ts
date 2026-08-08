import type { ExpressionContext } from '../context.js';
import { ExpressionEvalError } from '../errors.js';

/**
 * Every function receives arguments that are ALREADY evaluated, plus the context.
 *
 * The `unknown[]` is load-bearing: there is no way to hand a function an unevaluated
 * Ast, which is exactly why lambdas (map/filter/reduce) are impossible here and why
 * an unknown function name can stay a *parse* error for the IR validator to catch.
 */
export type Fn = (args: unknown[], ctx: ExpressionContext) => unknown;

/** An expression must never be able to allocate a gigabyte. */
export const MAX_PAD = 1000;
export const MAX_ITEMS = 10_000;
export const MAX_JSON_CHARS = 262_144;
/** Matches the node payload cap, so an expression cannot outgrow what can be stored. */
export const MAX_OUTPUT_CHARS = 262_144;

/**
 * Writes an OWN property.
 *
 * Plain `obj[key] = v` invokes the inherited setter when the key is literally
 * `__proto__`, so no own property is created and the value silently vanishes. That key
 * arrives in DATA, which the workflow author does not control.
 */
export function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function arity(name: string, args: unknown[], min: number, max: number = min): void {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : `${min} to ${max}`;
    throw new ExpressionEvalError(`${name}() expects ${want} argument(s), got ${args.length}`);
  }
}

/** Reports 'array' and 'null' separately, which `typeof` does not. */
export function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** `pos` is the 0-based argument index; messages report it 1-based. */
export function reject(name: string, pos: number, want: string, v: unknown): never {
  throw new ExpressionEvalError(`${name}() argument ${pos + 1} expects ${want}, got ${describeValue(v)}`);
}

export function str(name: string, v: unknown, pos: number): string {
  if (typeof v !== 'string') reject(name, pos, 'a string', v);
  return v;
}

export function num(name: string, v: unknown, pos: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) reject(name, pos, 'a finite number', v);
  return v;
}

export function int(name: string, v: unknown, pos: number): number {
  const n = num(name, v, pos);
  if (!Number.isInteger(n)) reject(name, pos, 'a whole number', v);
  return n;
}

export function arr(name: string, v: unknown, pos: number): unknown[] {
  if (!Array.isArray(v)) reject(name, pos, 'an array', v);
  return v;
}

export function obj(name: string, v: unknown, pos: number): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) reject(name, pos, 'an object', v);
  return v as Record<string, unknown>;
}

export function finite(name: string, n: number): number {
  if (!Number.isFinite(n)) throw new ExpressionEvalError(`${name}() produced a value that is not finite`);
  return n;
}
