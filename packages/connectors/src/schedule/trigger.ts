// cron-parser v4 is CommonJS; named ESM imports fail under real Node ESM (tsx),
// so use the default-import interop form.
import cronParser from 'cron-parser';
import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

function isValidCron(cron: string): boolean {
  try {
    cronParser.parseExpression(cron);
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(tz: string): boolean {
  // Intl.supportedValuesOf('timeZone') omits 'UTC'; constructing a formatter
  // throws RangeError for anything the runtime cannot resolve.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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
  display: {
    displayName: 'On a schedule',
    description: 'Start the workflow on a cron schedule in your timezone.',
    category: 'Triggers',
    glyph: '⏰',
  },
  paramsSchema,
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
