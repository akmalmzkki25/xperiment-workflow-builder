import { describe, expect, test } from 'vitest';
import { buildPayload, CONNECTION_FIELDS, CONNECTOR_KEYS } from '../src/lib/connectionFields';

describe('connectionFields', () => {
  test('covers every vault connector with at least one secret field', () => {
    expect(CONNECTOR_KEYS.sort()).toEqual([
      'gemini',
      'googleSheets',
      'openai',
      'postgres',
      'smtp',
      'telegram',
      'whatsapp',
    ]);
    for (const key of CONNECTOR_KEYS) {
      expect(CONNECTION_FIELDS[key]!.some((f) => f.secret)).toBe(true);
    }
  });

  test('new beta connectors flag their credential fields as secret', () => {
    expect(CONNECTION_FIELDS['whatsapp']!.find((f) => f.name === 'accessToken')?.secret).toBe(true);
    expect(CONNECTION_FIELDS['smtp']!.find((f) => f.name === 'password')?.secret).toBe(true);
    expect(CONNECTION_FIELDS['googleSheets']!.find((f) => f.name === 'privateKey')?.secret).toBe(true);
    // Non-secret identifiers stay visible.
    expect(CONNECTION_FIELDS['whatsapp']!.find((f) => f.name === 'phoneNumberId')?.secret).toBe(false);
  });

  test('buildPayload drops empty optional fields and trims values', () => {
    expect(buildPayload('telegram', { botToken: ' tok ', baseUrl: '' })).toEqual({ botToken: 'tok' });
    expect(buildPayload('telegram', { botToken: 'tok', baseUrl: 'http://localhost:3311' })).toEqual({
      botToken: 'tok',
      baseUrl: 'http://localhost:3311',
    });
  });

  test('buildPayload rejects missing required fields and unknown connectors', () => {
    expect(() => buildPayload('telegram', { baseUrl: 'x' })).toThrow(/Bot token/);
    expect(() => buildPayload('slack', {})).toThrow(/Unknown connector/);
  });
});
