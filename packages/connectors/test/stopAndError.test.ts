import { describe, expect, test } from 'vitest';
import { coreStopAndError, DEFAULT_STOP_CODE } from '../src/core/stopAndError.js';
import { NodeRunError, type NodeRunContext } from '../src/index.js';

function ctx(parameters: unknown): NodeRunContext {
  return {
    executionId: 'exec-1',
    nodeId: 'stop',
    attempt: 1,
    parameters,
    triggerBody: null,
    signal: new AbortController().signal,
    log: () => {},
  };
}

const thrown = async (parameters: unknown): Promise<NodeRunError> =>
  (await coreStopAndError.run(ctx(parameters)).catch((e: unknown) => e)) as NodeRunError;

describe('core.stopAndError', () => {
  test('declares no output ports', () => {
    // Empty ports mean validateGraph rejects any non-error outgoing edge at publish time.
    expect(coreStopAndError.outputPorts).toEqual([]);
  });

  test('always throws a non-retryable NodeRunError with the author message', async () => {
    const err = await thrown({ message: 'Pesanan tidak valid' });
    expect(err).toBeInstanceOf(NodeRunError);
    expect(err.message).toBe('Pesanan tidak valid');
    expect(err.code).toBe(DEFAULT_STOP_CODE);
    // shouldRetry is `retryable && attempt < maxAttempts`, so a deliberate stop must not
    // burn three attempts.
    expect(err.retryable).toBe(false);
  });

  test('uses the author code when supplied', async () => {
    const err = await thrown({ message: 'no stock', code: 'out_of_stock' });
    expect(err.code).toBe('out_of_stock');
  });

  test('wraps author details so an httpStatus key cannot make the stop retryable', async () => {
    // classifyError intercepts details.httpStatus and details.timeout and overrides
    // retryable with the HTTP policy. Forwarding the author's object raw would let them
    // accidentally re-open their own stop for three retries.
    const err = await thrown({ message: 'stop', details: { httpStatus: 500, timeout: true } });
    expect(err.details).toEqual({ authorDetails: { httpStatus: 500, timeout: true } });
    const details = err.details as { httpStatus?: unknown; timeout?: unknown };
    expect(details.httpStatus).toBeUndefined();
    expect(details.timeout).toBeUndefined();
  });

  test('omits details entirely when the author supplied none', async () => {
    const err = await thrown({ message: 'stop' });
    expect(err.details).toBeUndefined();
  });

  test('rejects an empty, oversized or malformed configuration', async () => {
    expect((await thrown({ message: '' })).code).toBe('invalid_parameters');
    expect((await thrown({ message: 'x'.repeat(501) })).code).toBe('invalid_parameters');
    expect((await thrown({ message: 'x', code: 'Not Snake Case' })).code).toBe('invalid_parameters');
    expect((await thrown({})).code).toBe('invalid_parameters');
  });
});
