import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z.object({ condition: z.unknown() }).strict();

export const coreIf: ConnectorDefinition = {
  type: 'core.if',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['true', 'false'],
  display: {
    displayName: 'Branch',
    description: 'Send the run down one of two paths based on a condition.',
    category: 'Logic',
    glyph: '⇉',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    const condition = parsed.data.condition;
    if (typeof condition !== 'boolean') {
      throw new NodeRunError(
        'condition_not_boolean',
        `core.if condition must resolve to a boolean, got ${typeof condition}`,
        false,
      );
    }
    return { output: { result: condition }, outputPort: condition ? 'true' : 'false' };
  },
};
