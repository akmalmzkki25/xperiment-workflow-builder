import { parseExpression } from 'cron-parser';

export function nextFireAt(cron: string, timezone: string, from: Date): Date {
  const it = parseExpression(cron, { currentDate: from, tz: timezone });
  return it.next().toDate();
}
