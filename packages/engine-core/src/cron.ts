// cron-parser v4 is CommonJS; named ESM imports fail under real Node ESM (tsx),
// so use the default-import interop form.
import cronParser from 'cron-parser';

export function nextFireAt(cron: string, timezone: string, from: Date): Date {
  const it = cronParser.parseExpression(cron, { currentDate: from, tz: timezone });
  return it.next().toDate();
}
