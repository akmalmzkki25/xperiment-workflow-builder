import { describe, expect, test } from 'vitest';
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  isRetryableHttpStatus,
  isRetryableTimeout,
  resolveRetryPolicy,
  shouldRetry,
  normalizedError,
} from '../src/index.js';

describe('DEFAULT_RETRY_POLICY', () => {
  test('matches the spec exactly', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 3,
      strategy: 'exponential-jitter',
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      retryOn: ['timeout', 408, 425, 429, 500, 502, 503, 504],
    });
  });
});

describe('resolveRetryPolicy', () => {
  test('merges partial node policy over defaults', () => {
    const p = resolveRetryPolicy({ maxAttempts: 5 });
    expect(p.maxAttempts).toBe(5);
    expect(p.initialDelayMs).toBe(1000);
    expect(p.retryOn).toEqual(DEFAULT_RETRY_POLICY.retryOn);
  });
  test('undefined yields defaults', () => {
    expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY);
  });
});

describe('retryability', () => {
  const policy = DEFAULT_RETRY_POLICY;
  test('http statuses follow retryOn', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) expect(isRetryableHttpStatus(s, policy)).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableHttpStatus(s, policy)).toBe(false);
  });
  test('timeout follows retryOn token', () => {
    expect(isRetryableTimeout(policy)).toBe(true);
    expect(isRetryableTimeout({ ...policy, retryOn: [500] })).toBe(false);
  });
  test('shouldRetry combines retryable flag and attempt budget', () => {
    const retryable = normalizedError('http_error', 'boom', true);
    const fatal = normalizedError('expression_error', 'bad', false);
    expect(shouldRetry(retryable, 1, policy)).toBe(true);
    expect(shouldRetry(retryable, 2, policy)).toBe(true);
    expect(shouldRetry(retryable, 3, policy)).toBe(false); // attempt 3 of maxAttempts 3 -> no more
    expect(shouldRetry(fatal, 1, policy)).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  const policy = DEFAULT_RETRY_POLICY;
  test('exponential base with deterministic jitter in [0.5, 1.0]', () => {
    expect(computeBackoffMs(1, policy, () => 0)).toBe(500); // 1000 * 0.5
    expect(computeBackoffMs(1, policy, () => 1)).toBe(1000); // 1000 * 1.0
    expect(computeBackoffMs(2, policy, () => 0)).toBe(1000); // 2000 * 0.5
    expect(computeBackoffMs(3, policy, () => 1)).toBe(4000); // 4000 * 1.0
  });
  test('caps at maxDelayMs before jitter', () => {
    expect(computeBackoffMs(30, policy, () => 1)).toBe(60000);
    expect(computeBackoffMs(30, policy, () => 0)).toBe(30000);
  });
  test('random jitter stays within bounds', () => {
    for (let i = 0; i < 50; i += 1) {
      const v = computeBackoffMs(2, policy);
      expect(v).toBeGreaterThanOrEqual(1000);
      expect(v).toBeLessThanOrEqual(2000);
    }
  });
});
