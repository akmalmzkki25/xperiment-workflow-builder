import { NodeRunError } from '../types.js';

/** Above this an operation fails rather than truncating — a truncated list is a silent lie. */
export const MAX_ITEMS = 10_000;

export const FILTER_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'in',
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Dotted path; a numeric segment indexes an array. An EMPTY field means the element
 * itself, which is what lets core.sort order a list of plain scalars.
 */
export function readField(name: string, row: unknown, field: string): unknown {
  if (field === '') return row;
  let cur: unknown = row;
  for (const segment of field.split('.')) {
    if (FORBIDDEN.has(segment)) {
      throw new NodeRunError('forbidden_field_path', `${name} refuses the field segment '${segment}'`, false);
    }
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** A type predicate, not a boolean: callers below rely on it to narrow `unknown`. */
function isAbsent(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isEmptyValue(v: unknown): boolean {
  if (isAbsent(v)) return true;
  if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  // Emptiness is about containers. Matches the expression language's isEmpty() exactly,
  // so the two layers cannot drift.
  return false;
}

/**
 * Returns false rather than throwing when the two sides are not comparable.
 *
 * This is the deliberate divergence from the expression language, which throws. A filter
 * over 5000 rows where one has a null price must DROP that row, not kill the run —
 * removing rows that do not qualify is exactly the job.
 */
export function applyOp(op: FilterOp, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      // Narrowed in the guards rather than through a boolean, so the compiler can
      // actually see that both sides are the same comparable type.
      if (typeof left === 'number' && typeof right === 'number') return relational(op, left, right);
      if (typeof left === 'string' && typeof right === 'string') return relational(op, left, right);
      return false;
    case 'contains':
      // Array membership is `in`. This one stays string-only on both sides.
      return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    case 'startsWith':
      return typeof left === 'string' && typeof right === 'string' && left.startsWith(right);
    case 'endsWith':
      return typeof left === 'string' && typeof right === 'string' && left.endsWith(right);
    case 'in':
      return Array.isArray(right) && right.includes(left);
    case 'isNull':
      return isAbsent(left);
    case 'isNotNull':
      return !isAbsent(left);
    case 'isEmpty':
      return isEmptyValue(left);
    default:
      return !isEmptyValue(left);
  }
}

function relational(op: 'gt' | 'gte' | 'lt' | 'lte', l: number | string, r: number | string): boolean {
  switch (op) {
    case 'gt':
      return l > r;
    case 'gte':
      return l >= r;
    case 'lt':
      return l < r;
    default:
      return l <= r;
  }
}

/** number < string < boolean < everything else, so a mixed list still has a total order. */
function typeRank(v: unknown): number {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

/**
 * Absent values sort LAST, in ascending AND descending order.
 *
 * Null means "no data". Burying it at both ends is what a person means by "sort by
 * price, highest first" when some rows have no price — deliberately not SQL's default.
 */
export function compareValues(a: unknown, b: unknown): number {
  const aAbsent = isAbsent(a);
  const bAbsent = isAbsent(b);
  if (aAbsent && bAbsent) return 0;
  if (aAbsent) return 1;
  if (bAbsent) return -1;

  const rank = typeRank(a) - typeRank(b);
  if (rank !== 0) return rank;

  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // UTF-16 code units, never localeCompare: locale collation varies with the ICU version.
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertItems(name: string, items: unknown): unknown[] {
  if (!Array.isArray(items)) {
    throw new NodeRunError('items_not_array', `${name} expects items to resolve to an array`, false);
  }
  if (items.length > MAX_ITEMS) {
    // Non-retryable: retrying will not shorten the list.
    throw new NodeRunError('too_many_items', `${name} refuses more than ${MAX_ITEMS} items`, false);
  }
  return items;
}
