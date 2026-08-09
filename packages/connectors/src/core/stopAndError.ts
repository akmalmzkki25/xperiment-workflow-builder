import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    message: z.string().min(1).max(500),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/, 'code must be lower_snake_case')
      .optional(),
    details: z.unknown(),
  })
  .strict();

export const DEFAULT_STOP_CODE = 'stopped_by_author';

export const coreStopAndError: ConnectorDefinition = {
  type: 'core.stopAndError',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  /**
   * EMPTY, deliberately. There is no success path, so validateGraph's port check rejects
   * any outgoing edge other than `error` at publish time — a free, correct guard that
   * costs no change to packages/ir.
   */
  outputPorts: [],
  display: {
    displayName: 'Stop with an error',
    description: 'End the run immediately and mark it failed.',
    category: 'Logic',
    glyph: '⛔',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const { message, code, details } = parsed.data;
    throw new NodeRunError(
      code ?? DEFAULT_STOP_CODE,
      message,
      // Never retryable: shouldRetry is `error.retryable && attempt < maxAttempts`, so a
      // deliberate stop must not burn three attempts.
      false,
      // WRAPPED, never forwarded raw. classifyError (apps/worker/src/classify.ts:14-20)
      // reclassifies any NodeRunError whose details carry `httpStatus` or `timeout`, and
      // overrides retryable with the HTTP policy — so an author writing
      // details: {"httpStatus": 500} would get their own stop retried three times.
      details === undefined ? undefined : { authorDetails: details },
    );
  },
};
