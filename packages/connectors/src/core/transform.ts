import { z } from 'zod';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z.object({ fields: z.record(z.string(), z.unknown()) }).strict();

export const coreTransform: ConnectorDefinition = {
  type: 'core.transform',
  kind: 'logic',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  display: {
    displayName: 'Build a record',
    description: 'Make a new record with the fields and values you choose.',
    category: 'Data',
    glyph: 'ƒ',
  },
  paramsSchema,
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) {
      throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    }
    return { output: structuredClone(parsed.data.fields) };
  },
};
