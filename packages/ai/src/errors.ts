/** Provider failure. `status` is the HTTP status, or null for network/shape errors. */
export class AiProviderError extends Error {
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Thrown/returned when no provider key is configured. */
export class AiUnconfiguredError extends Error {
  constructor(message = 'AI provider is not configured') {
    super(message);
    this.name = 'AiUnconfiguredError';
  }
}
