import { parseExpression } from 'cron-parser';
import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

function isValidCron(cron: string): boolean {
  try {
    parseExpression(cron);
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(tz: string): boolean {
  return (Intl.supportedValuesOf('timeZone') as string[]).includes(tz);
}

const paramsSchema = z
  .object({
    cron: z.string().refine(isValidCron, 'invalid cron expression'),
    timezone: z.string().refine(isValidTimezone, 'invalid IANA timezone').optional(),
  })
  .strict();

export const scheduleTrigger: ConnectorDefinition = {
  type: 'schedule.trigger',
  kind: 'trigger',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  paramsSchema,
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
