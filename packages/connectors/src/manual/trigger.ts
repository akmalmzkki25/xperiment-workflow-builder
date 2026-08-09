import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

export const manualTrigger: ConnectorDefinition = {
  type: 'manual.trigger',
  kind: 'trigger',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  display: {
    displayName: 'Manual start',
    description: 'Start the workflow yourself, from the editor or the API.',
    category: 'Triggers',
    glyph: '▷',
  },
  paramsSchema: z.object({}).strict(),
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
