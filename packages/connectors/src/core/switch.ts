import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

export const SWITCH_MAX_CASES = 10;

/**
 * Ports are fixed and POSITIONAL, so `packages/ir` stays untouched: validateGraph reads
 * this static array to reject an unknown output port. Letting a case declare its own port
 * name would need that name cross-checked against the array, and that check would have to
 * live in the IR layer, which never reads node parameters.
 */
const PORTS = [
  ...Array.from({ length: SWITCH_MAX_CASES }, (_, i) => `case${i + 1}`),
  'default',
];

const paramsSchema = z
  .object({
    value: z.unknown(),
    cases: z
      .array(z.object({ equals: z.unknown() }).strict())
      .min(1)
      .max(SWITCH_MAX_CASES)
      .superRefine((cases, c) => {
        // z.unknown() is OPTIONAL in zod, so `cases: [{}]` parses — and `equals ?? null`
        // would turn a half-written case into a catch-all sitting ahead of the real ones.
        // .strict() catches an extra key; only this catches a missing one.
        cases.forEach((entry, i) => {
          if (!Object.hasOwn(entry, 'equals')) {
            c.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'each case needs an explicit equals — write null for the null case',
              path: [i, 'equals'],
            });
          }
        });
      }),
  })
  .strict();

const MAX_DEPTH = 32;

/**
 * Primitives compare strictly, so 150 never matches '150'. Objects and arrays compare
 * STRUCTURALLY: an author cannot produce the same reference twice, so reference equality
 * would mean an object case silently never fires and always falls through to default.
 */
function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > MAX_DEPTH) {
    // Answering "not equal" past a depth budget takes a BRANCH on a value it never
    // actually compared — two structurally equal payloads would route to default.
    // Every other bounded operation in this set fails loudly; so does this one.
    throw new NodeRunError(
      'value_too_deep',
      `core.switch cannot compare values nested deeper than ${MAX_DEPTH} levels`,
      false,
    );
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i], depth + 1));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(right, k) && sameValue(left[k], right[k], depth + 1),
  );
}

export const coreSwitch: ConnectorDefinition = {
  type: 'core.switch',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: PORTS,
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    // Normalise once, on the way in. The expression language already turns a missing path
    // into null, so an absent `value` is the same thing — and normalising only on the way
    // out would report `value: null` while routing it as unmatched.
    const value = parsed.data.value ?? null;
    const index = parsed.data.cases.findIndex((c) => sameValue(value, c.equals ?? null));
    if (index === -1) {
      return { output: { matched: false, caseIndex: null, value }, outputPort: 'default' };
    }
    // caseIndex is 0-based; the port is 1-based, because ports read better to a human.
    return { output: { matched: true, caseIndex: index, value }, outputPort: `case${index + 1}` };
  },
};
