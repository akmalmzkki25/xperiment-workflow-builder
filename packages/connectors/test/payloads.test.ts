import { describe, expect, test } from 'vitest';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../src/index.js';

describe('CONNECTION_PAYLOAD_SCHEMAS', () => {
  test('validates the four payload shapes strictly', () => {
    expect(CONNECTION_PAYLOAD_SCHEMAS.postgres.safeParse({ connectionString: 'postgres://x' }).success).toBe(true);
    expect(CONNECTION_PAYLOAD_SCHEMAS.postgres.safeParse({}).success).toBe(false);
    expect(CONNECTION_PAYLOAD_SCHEMAS.telegram.safeParse({ botToken: 't' }).success).toBe(true);
    expect(CONNECTION_PAYLOAD_SCHEMAS.telegram.safeParse({ botToken: 't', baseUrl: 'http://s' }).success).toBe(true);
    expect(CONNECTION_PAYLOAD_SCHEMAS.openai.safeParse({ apiKey: 'k', extra: 1 }).success).toBe(false);
    expect(CONNECTION_PAYLOAD_SCHEMAS.gemini.safeParse({ apiKey: 'k' }).success).toBe(true);
  });
});
