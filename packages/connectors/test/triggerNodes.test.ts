import { describe, expect, test } from 'vitest';
import { createDefaultRegistry, type NodeRunContext } from '../src/index.js';

const registry = createDefaultRegistry();

function ctx(parameters: unknown, triggerBody: unknown): NodeRunContext {
  return {
    executionId: 'e',
    nodeId: 'n',
    attempt: 1,
    parameters,
    triggerBody,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('webhook.trigger', () => {
  const def = () => registry.get('webhook.trigger')!;

  test('is registered as a trigger with main port', () => {
    expect(def().kind).toBe('trigger');
    expect(def().outputPorts).toEqual(['main']);
  });

  test('params schema accepts auth modes and optional dot-path', () => {
    expect(def().paramsSchema.safeParse({ authMode: 'hmac' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ authMode: 'token', idempotencyKeyPath: 'event.id' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ authMode: 'basic' }).success).toBe(false);
    expect(def().paramsSchema.safeParse({}).success).toBe(false);
  });

  test('runner passes the stored trigger payload through', async () => {
    const payload = { body: { a: 1 }, headers: {}, query: {} };
    const r = await def().run(ctx({ authMode: 'none' }, payload));
    expect(r).toEqual({ output: payload });
  });
});

describe('schedule.trigger', () => {
  const def = () => registry.get('schedule.trigger')!;

  test('params schema validates cron and timezone', () => {
    expect(def().paramsSchema.safeParse({ cron: '*/5 * * * *' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ cron: '0 9 * * *', timezone: 'Asia/Jakarta' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ cron: 'garbage' }).success).toBe(false);
    expect(def().paramsSchema.safeParse({ cron: '* * * * *', timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  test('runner passes the scheduler payload through', async () => {
    const payload = { firedAt: 'x', scheduledFor: 'y' };
    const r = await def().run(ctx({ cron: '* * * * *' }, payload));
    expect(r).toEqual({ output: payload });
  });
});
