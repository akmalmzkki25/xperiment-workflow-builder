import { ApiError } from './api';

/**
 * The problem detail of a permission 403, or null for any other outcome.
 *
 * Every list screen derives its rows from `query.data?.items ?? []`, so a 403
 * would otherwise render as "nothing here" — telling a member the workspace is
 * empty when they simply may not look. Pages branch on this before that fallback.
 */
export function forbiddenDetail(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  return error.detail ?? error.title;
}
