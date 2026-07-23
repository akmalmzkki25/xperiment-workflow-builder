import type { RetryPolicy } from '@xperiment/ir';
import type { NormalizedError } from './errors.js';

export interface ResolvedRetryPolicy {
  maxAttempts: number;
  strategy: 'exponential-jitter';
  initialDelayMs: number;
  maxDelayMs: number;
  retryOn: (number | 'timeout')[];
}

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  maxAttempts: 3,
  strategy: 'exponential-jitter',
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  retryOn: ['timeout', 408, 425, 429, 500, 502, 503, 504],
};

export function resolveRetryPolicy(p?: RetryPolicy): ResolvedRetryPolicy {
  if (!p) return DEFAULT_RETRY_POLICY;
  return {
    maxAttempts: p.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    strategy: 'exponential-jitter',
    initialDelayMs: p.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs,
    maxDelayMs: p.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    retryOn: p.retryOn ?? DEFAULT_RETRY_POLICY.retryOn,
  };
}

export function isRetryableHttpStatus(status: number, policy: ResolvedRetryPolicy): boolean {
  return policy.retryOn.includes(status);
}

export function isRetryableTimeout(policy: ResolvedRetryPolicy): boolean {
  return policy.retryOn.includes('timeout');
}

export function shouldRetry(error: NormalizedError, attempt: number, policy: ResolvedRetryPolicy): boolean {
  return error.retryable && attempt < policy.maxAttempts;
}

export function computeBackoffMs(
  attempt: number,
  policy: ResolvedRetryPolicy,
  rng: () => number = Math.random,
): number {
  const base = policy.initialDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);
  return Math.round(capped * (0.5 + rng() * 0.5));
}
