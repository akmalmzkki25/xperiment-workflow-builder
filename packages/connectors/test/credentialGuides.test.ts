import { describe, expect, test } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { connectionSchemas } from '../src/catalog.js';
import { CREDENTIAL_GUIDES } from '../src/credentialGuides.js';
import { CONNECTION_PAYLOAD_SCHEMAS, type ConnectorKey } from '../src/payloads.js';

const KEYS = Object.keys(CONNECTION_PAYLOAD_SCHEMAS) as ConnectorKey[];

function payloadFieldNames(key: ConnectorKey): string[] {
  const schema = zodToJsonSchema(CONNECTION_PAYLOAD_SCHEMAS[key], {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as { properties?: Record<string, unknown> };
  return Object.keys(schema.properties ?? {}).sort();
}

describe('CREDENTIAL_GUIDES', () => {
  test('every connector that needs a credential explains how to get one', () => {
    // The Record is exhaustive over ConnectorKey, so an eleventh payload schema is a
    // compile error until its guide exists. This is that guarantee, made runtime-visible.
    expect(Object.keys(CREDENTIAL_GUIDES).sort()).toEqual([...KEYS].sort());
  });

  test('the fields a guide documents are exactly the fields the form will show', () => {
    // The failure this catches: somebody renames botToken and the guide keeps telling
    // people to paste it into a field that no longer exists.
    for (const key of KEYS) {
      expect(CREDENTIAL_GUIDES[key].fields.map((f) => f.name).sort(), key).toEqual(payloadFieldNames(key));
    }
  });

  test('every guide has steps, and every step says something', () => {
    for (const key of KEYS) {
      const guide = CREDENTIAL_GUIDES[key];
      expect(guide.steps.length, key).toBeGreaterThan(0);
      expect(guide.summary.length, key).toBeGreaterThan(20);
      for (const step of guide.steps) {
        expect(step.title.length, `${key}: ${step.title}`).toBeGreaterThan(4);
        expect(step.detail.length, `${key}: ${step.title}`).toBeGreaterThan(20);
      }
    }
  });

  test('a secret field is marked secret, so nothing renders a live token in plain text', () => {
    // Mirrors the allowlist in the web form: anything not obviously public is a password.
    const PUBLIC = new Set(['baseUrl', 'tokenUrl', 'host', 'port', 'user', 'from', 'secure', 'phoneNumberId', 'serviceAccountEmail', 'testSpreadsheetId']);
    for (const key of KEYS) {
      for (const field of CREDENTIAL_GUIDES[key].fields) {
        expect(field.secret, `${key}.${field.name}`).toBe(!PUBLIC.has(field.name));
      }
    }
  });

  test('no example of a SECRET field is a plausible live credential', () => {
    // An example that looks real is one somebody pastes and then wonders why it fails.
    // Scoped to secret fields on purpose: a public base URL is documentation, and
    // 'https://api.telegram.org' is exactly the value we want people to see.
    for (const key of KEYS) {
      for (const field of CREDENTIAL_GUIDES[key].fields) {
        if (!field.secret || field.example === undefined) continue;
        expect(field.example.toLowerCase(), `${key}.${field.name}`).toMatch(/example|your-|xxxx|\.\.\./);
      }
    }
  });

  test('a docsUrl, where present, is https', () => {
    for (const key of KEYS) {
      const url = CREDENTIAL_GUIDES[key].docsUrl;
      if (url !== undefined) expect(url, key).toMatch(/^https:\/\//);
    }
  });

  test('telegram says the thing that actually traps people', () => {
    // chatId is on the node, not on this form. Somebody told "get a token and a chat id"
    // who then sees two fields, neither called chat id, is stuck — and nothing in the
    // product says a word about it today.
    const cautions = CREDENTIAL_GUIDES.telegram.cautions.join(' ').toLowerCase();
    expect(cautions).toContain('chat id');
    const steps = CREDENTIAL_GUIDES.telegram.steps.map((s) => `${s.title} ${s.detail}`).join(' ');
    expect(steps).toContain('BotFather');
    expect(steps).toContain('getUpdates');
  });
});

describe('connectionSchemas', () => {
  test('serves the guide alongside the payload schema, so the form needs one round trip', () => {
    const items = connectionSchemas();
    expect(items).toHaveLength(KEYS.length);
    for (const item of items) {
      expect(item.guide, item.connectorKey).toBeDefined();
      expect(item.guide.displayName.length, item.connectorKey).toBeGreaterThan(0);
    }
  });
});
