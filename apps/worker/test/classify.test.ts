import { NodeRunError } from '@xperiment/connectors';
import { PayloadTooLargeError } from '@xperiment/db';
import { DEFAULT_RETRY_POLICY } from '@xperiment/engine-core';
import { ExpressionEvalError, ExpressionParseError } from '@xperiment/expressions';
import { describe, expect, test } from 'vitest';
import { classifyError } from '../src/classify.js';

const policy = DEFAULT_RETRY_POLICY;

describe('classifyError', () => {
  test('http status errors follow policy retryOn', () => {
    const e503 = classifyError(new NodeRunError('http_error', 'HTTP 503', false, { httpStatus: 503 }), policy);
    expect(e503).toMatchObject({ code: 'http_error', retryable: true });
    const e404 = classifyError(new NodeRunError('http_error', 'HTTP 404', false, { httpStatus: 404 }), policy);
    expect(e404).toMatchObject({ code: 'http_error', retryable: false });
  });

  test('timeouts follow the timeout token', () => {
    const t = classifyError(new NodeRunError('timeout', 'timed out', false, { timeout: true }), policy);
    expect(t).toMatchObject({ code: 'timeout', retryable: true });
    const noTimeoutPolicy = { ...policy, retryOn: [500] };
    const t2 = classifyError(new NodeRunError('timeout', 'timed out', false, { timeout: true }), noTimeoutPolicy);
    expect(t2.retryable).toBe(false);
  });

  test('other NodeRunErrors keep their own facts', () => {
    const net = classifyError(new NodeRunError('network_error', 'refused', true), policy);
    expect(net).toMatchObject({ code: 'network_error', retryable: true });
    const ssrf = classifyError(new NodeRunError('ssrf_blocked', 'blocked', false), policy);
    expect(ssrf).toMatchObject({ code: 'ssrf_blocked', retryable: false });
  });

  test('expression and payload errors are never retryable', () => {
    expect(classifyError(new ExpressionParseError('bad', 3), policy)).toMatchObject({
      code: 'expression_error',
      retryable: false,
    });
    expect(classifyError(new ExpressionEvalError('bad'), policy)).toMatchObject({
      code: 'expression_error',
      retryable: false,
    });
    expect(classifyError(new PayloadTooLargeError(999999), policy)).toMatchObject({
      code: 'payload_too_large',
      retryable: false,
    });
  });

  test('unknown errors become internal_error, not retryable', () => {
    expect(classifyError(new Error('boom'), policy)).toMatchObject({ code: 'internal_error', retryable: false });
    expect(classifyError('string-throw', policy)).toMatchObject({ code: 'internal_error', retryable: false });
  });
});
