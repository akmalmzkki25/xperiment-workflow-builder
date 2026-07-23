export interface NormalizedError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export function normalizedError(
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): NormalizedError {
  return details === undefined ? { code, message, retryable } : { code, message, retryable, details };
}
