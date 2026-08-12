import { connectionSchemas } from '@xperiment/connectors';
import { describe, expect, test } from 'vitest';
import {
  buildPayload,
  deriveFields,
  humanizeFieldName,
  type ConnectionField,
  type JsonSchemaLike,
} from '../src/lib/connectionFields';

/** The real server payload, so these tests fail when the schema changes. */
function schemaFor(connectorKey: string): JsonSchemaLike {
  const found = connectionSchemas().find((s) => s.connectorKey === connectorKey);
  if (!found) throw new Error(`no schema for ${connectorKey}`);
  return found.payloadJsonSchema as JsonSchemaLike;
}

const fieldsFor = (key: string): ConnectionField[] => deriveFields(key, schemaFor(key));
const byName = (key: string, name: string): ConnectionField | undefined =>
  fieldsFor(key).find((f) => f.name === name);

describe('deriveFields against the real server schemas', () => {
  test('covers every vault connector', () => {
    expect(connectionSchemas().map((s) => s.connectorKey).sort()).toEqual([
      'gemini',
      'googleSheets',
      'midtrans',
      'openai',
      'postgres',
      'slack',
      'smtp',
      'telegram',
      'whatsapp',
      'xendit',
    ]);
  });

  test('every connector has at least one masked field', () => {
    for (const { connectorKey } of connectionSchemas()) {
      expect(fieldsFor(connectorKey).some((f) => f.kind === 'password'), connectorKey).toBe(true);
    }
  });

  test('renders the fields the hand-written copy had silently lost', () => {
    // These three existed on the server and had no input at all, so an SMTP connection
    // over implicit TLS was not expressible from the UI. This is the drift the whole
    // change exists to end.
    expect(byName('smtp', 'secure')).toBeDefined();
    expect(byName('googleSheets', 'baseUrl')).toBeDefined();
    expect(byName('googleSheets', 'tokenUrl')).toBeDefined();
  });

  test('required tracks the schema, not a guess', () => {
    expect(byName('smtp', 'host')!.required).toBe(true);
    expect(byName('smtp', 'secure')!.required).toBe(false);
    expect(byName('telegram', 'botToken')!.required).toBe(true);
    expect(byName('telegram', 'baseUrl')!.required).toBe(false);
  });

  test('credentials are masked and identifiers are not', () => {
    expect(byName('whatsapp', 'accessToken')!.kind).toBe('password');
    expect(byName('smtp', 'password')!.kind).toBe('password');
    expect(byName('googleSheets', 'privateKey')!.kind).toBe('password');
    expect(byName('whatsapp', 'phoneNumberId')!.kind).toBe('text');
  });

  test('a port is a number and a boolean is a checkbox', () => {
    expect(byName('smtp', 'port')!.kind).toBe('number');
    // `secure` arrives as anyOf[boolean, "true"|"false"], not a plain boolean.
    expect(byName('smtp', 'secure')!.kind).toBe('checkbox');
  });

  test('declaration order is preserved, because the schemas read in that order', () => {
    expect(fieldsFor('smtp').map((f) => f.name)).toEqual(['host', 'port', 'user', 'password', 'from', 'secure']);
  });
});

describe('masking fails closed', () => {
  test('a field name this file has never seen is masked, not shown', () => {
    // The allowlist direction is the point: the cost of being wrong is a masked field
    // somebody retypes, not a live token rendered on a shared screen.
    //
    // The names below deliberately avoid `token`, `key`, `secret` and `password`. A
    // substring heuristic would pass this test while leaving `merchantSalt` in plain
    // text, so anything that looks like a credential-name pattern must fail here.
    for (const name of ['merchantSalt', 'signingMaterial', 'clientAssertion']) {
      const schema: JsonSchemaLike = { properties: { [name]: { type: 'string' } }, required: [] };
      expect(deriveFields('future', schema)[0]!.kind, name).toBe('password');
    }
  });

  test('a boolean or numeric field this file has never seen is still masked', () => {
    // Type is not evidence of publicness. Only the allowlist is.
    const schema: JsonSchemaLike = { properties: { hiddenPort: { type: 'integer' } }, required: [] };
    expect(deriveFields('future', schema)[0]!.kind).toBe('password');
  });
});

describe('humanizeFieldName', () => {
  test('reads as a sentence, with acronyms intact', () => {
    expect(humanizeFieldName('baseUrl')).toBe('Base URL');
    expect(humanizeFieldName('apiKey')).toBe('API key');
    expect(humanizeFieldName('phoneNumberId')).toBe('Phone number ID');
    expect(humanizeFieldName('serviceAccountEmail')).toBe('Service account email');
    expect(humanizeFieldName('host')).toBe('Host');
  });

  test('a hand-written label wins where it reads better', () => {
    expect(byName('googleSheets', 'privateKey')!.label).toBe('Service account private key');
  });

  test('an empty name is returned rather than crashing', () => {
    expect(humanizeFieldName('')).toBe('');
  });
});

describe('buildPayload', () => {
  const telegram = fieldsFor('telegram');
  const smtp = fieldsFor('smtp');

  test('drops empty optional fields and trims values', () => {
    expect(buildPayload(telegram, { botToken: ' tok ', baseUrl: '' })).toEqual({ botToken: 'tok' });
    expect(buildPayload(telegram, { botToken: 'tok', baseUrl: 'http://localhost:3311' })).toEqual({
      botToken: 'tok',
      baseUrl: 'http://localhost:3311',
    });
  });

  test('rejects a missing required field by its label', () => {
    expect(() => buildPayload(telegram, { baseUrl: 'x' })).toThrow(/Bot token/);
  });

  test('a numeric field is sent as a number', () => {
    const payload = buildPayload(smtp, {
      host: 'smtp.test',
      port: '587',
      user: 'u',
      password: 'p',
      from: 'a@b.c',
    });
    expect(payload['port']).toBe(587);
  });

  test('an unchecked box is omitted rather than sent as false', () => {
    // Every boolean here is optional. Sending an explicit false where the author meant
    // "leave it alone" only shows up against a real provider.
    const base = { host: 'h', port: '25', user: 'u', password: 'p', from: 'a@b.c' };
    expect('secure' in buildPayload(smtp, base)).toBe(false);
    expect(buildPayload(smtp, { ...base, secure: 'true' })['secure']).toBe(true);
  });

  test('an empty field list yields an empty payload rather than throwing', () => {
    expect(buildPayload([], {})).toEqual({});
  });
});
