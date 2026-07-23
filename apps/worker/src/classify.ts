import { NodeRunError } from '@xperiment/connectors';
import { PayloadTooLargeError } from '@xperiment/db';
import {
  isRetryableHttpStatus,
  isRetryableTimeout,
  normalizedError,
  type NormalizedError,
  type ResolvedRetryPolicy,
} from '@xperiment/engine-core';
import { ExpressionEvalError, ExpressionParseError } from '@xperiment/expressions';

export function classifyError(err: unknown, policy: ResolvedRetryPolicy): NormalizedError {
  if (err instanceof NodeRunError) {
    const details = (err.details ?? {}) as { httpStatus?: number; timeout?: boolean };
    if (typeof details.httpStatus === 'number') {
      return normalizedError('http_error', err.message, isRetryableHttpStatus(details.httpStatus, policy), err.details);
    }
    if (details.timeout === true) {
      return normalizedError('timeout', err.message, isRetryableTimeout(policy), err.details);
    }
    return normalizedError(err.code, err.message, err.retryable, err.details);
  }
  if (err instanceof ExpressionParseError || err instanceof ExpressionEvalError) {
    return normalizedError('expression_error', err.message, false);
  }
  if (err instanceof PayloadTooLargeError) {
    return normalizedError('payload_too_large', err.message, false);
  }
  const message = err instanceof Error ? err.message : String(err);
  return normalizedError('internal_error', message, false);
}
