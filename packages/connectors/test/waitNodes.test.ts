import { describe, expect, test } from 'vitest';
import { coreApproval, coreDelay, coreWaitForEvent, NodeRunError } from '../src/index.js';
import type { NodeRunContext } from '../src/index.js';

const ctx = (parameters: unknown): NodeRunContext => ({
  executionId: 'e',
  nodeId: 'n',
  attempt: 1,
  parameters,
  triggerBody: null,
  signal: AbortSignal.timeout(1000),
  log: () => {},
});

describe('core.delay', () => {
  test('suspends with a relative timer', async () => {
    const r = await coreDelay.run(ctx({ durationMs: 5000 }));
    expect(r.suspend).toEqual({ kind: 'timer', delayMs: 5000 });
    expect(r.output).toBeUndefined();
  });
  test('rejects a non-positive or oversized duration', async () => {
    await expect(coreDelay.run(ctx({ durationMs: 0 }))).rejects.toBeInstanceOf(NodeRunError);
    await expect(coreDelay.run(ctx({ durationMs: 9_999_999_999 }))).rejects.toBeInstanceOf(NodeRunError);
  });
});

describe('core.waitForEvent', () => {
  test('suspends as an event wait, with an optional ttl', async () => {
    expect((await coreWaitForEvent.run(ctx({}))).suspend).toEqual({ kind: 'event' });
    expect((await coreWaitForEvent.run(ctx({ timeoutMs: 60000 }))).suspend).toEqual({ kind: 'event', ttlMs: 60000 });
  });
});

describe('core.approval', () => {
  test('suspends as an approval with message, ttl and fallback; exposes both ports', async () => {
    expect(coreApproval.outputPorts).toEqual(['approved', 'rejected']);
    const r = await coreApproval.run(ctx({ message: 'Approve?', ttlMs: 86400000, fallback: 'reject' }));
    expect(r.suspend).toEqual({ kind: 'approval', ttlMs: 86400000, fallback: 'reject', message: 'Approve?' });
  });
  test('rejects an unknown fallback or empty message', async () => {
    await expect(coreApproval.run(ctx({ message: '', ttlMs: 1000, fallback: 'reject' }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
    await expect(coreApproval.run(ctx({ message: 'x', ttlMs: 1000, fallback: 'maybe' }))).rejects.toBeInstanceOf(
      NodeRunError,
    );
  });
});
