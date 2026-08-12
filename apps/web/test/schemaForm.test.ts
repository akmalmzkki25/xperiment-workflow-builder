import { connectorCatalog, createDefaultRegistry } from '@xperiment/connectors';
import { describe, expect, test } from 'vitest';
import {
  defaultParams,
  deriveFields,
  fieldValueToParam,
  nodeReadiness,
  type FormField,
} from '../src/lib/schemaForm';

const catalog = connectorCatalog(createDefaultRegistry());
const schemaOf = (type: string): unknown => catalog.find((i) => i.type === type)!.paramsJsonSchema;
const field = (fields: FormField[], name: string): FormField => {
  const f = fields.find((x) => x.name === name);
  if (!f) throw new Error(`field ${name} missing in ${JSON.stringify(fields)}`);
  return f;
};

describe('deriveFields against real connector schemas', () => {
  test('webhook.trigger: enum select + optional text', () => {
    const fields = deriveFields(schemaOf('webhook.trigger'));
    const authMode = field(fields, 'authMode');
    expect(authMode.kind).toBe('select');
    expect(authMode.required).toBe(true);
    // The last three are provider schemes, not strength choices: Meta signs under its own
    // header, Xendit sends a bare token, Midtrans puts a digest inside the body.
    expect(authMode.options).toEqual(['none', 'token', 'hmac', 'meta', 'xendit', 'midtrans']);
    const idem = field(fields, 'idempotencyKeyPath');
    expect(idem.kind).toBe('text');
    expect(idem.required).toBe(false);
  });

  test('core.transform: record maps to a required json field', () => {
    const fields = deriveFields(schemaOf('core.transform'));
    expect(field(fields, 'fields').kind).toBe('json');
    expect(field(fields, 'fields').required).toBe(true);
  });

  test('core.if: unknown condition maps to json', () => {
    const fields = deriveFields(schemaOf('core.if'));
    expect(field(fields, 'condition').kind).toBe('json');
  });

  test('http.request: string, enum, record and number fields', () => {
    const fields = deriveFields(schemaOf('http.request'));
    expect(field(fields, 'url').kind).toBe('text');
    expect(field(fields, 'url').required).toBe(true);
    expect(field(fields, 'method').kind).toBe('select');
    expect(field(fields, 'method').options).toContain('POST');
    expect(field(fields, 'headers').kind).toBe('json');
    expect(field(fields, 'headers').required).toBe(false);
  });

  test('labels humanize camelCase names', () => {
    const fields = deriveFields(schemaOf('webhook.trigger'));
    expect(field(fields, 'idempotencyKeyPath').label).toBe('Idempotency key path');
  });

  test('non-object schema yields no fields', () => {
    expect(deriveFields(null)).toEqual([]);
    expect(deriveFields({ type: 'string' })).toEqual([]);
  });
});

describe('defaultParams', () => {
  test('picks first enum value and empty containers for required fields', () => {
    expect(defaultParams(schemaOf('webhook.trigger'))).toEqual({ authMode: 'none' });
    expect(defaultParams(schemaOf('core.transform'))).toEqual({ fields: {} });
  });

  test('required strings default to empty string; optionals omitted', () => {
    const d = defaultParams(schemaOf('http.request')) as Record<string, unknown>;
    expect(d['url']).toBe('');
    expect(d['method']).toBe('GET');
    expect('headers' in d).toBe(false);
  });
});

describe('nodeReadiness', () => {
  const fields = deriveFields(schemaOf('telegram.sendMessage'));

  test('missing connection wins over missing config', () => {
    expect(
      nodeReadiness({ parameters: {}, fields, requiresConnection: 'telegram' }),
    ).toBe('needs-connection');
  });

  test('empty required field means needs-config', () => {
    expect(
      nodeReadiness({
        parameters: { chatId: '', text: 'hi' },
        fields,
        requiresConnection: 'telegram',
        connectionRef: 'ref-1',
      }),
    ).toBe('needs-config');
  });

  test('all required fields present means ready', () => {
    expect(
      nodeReadiness({
        parameters: { chatId: '123', text: 'hi' },
        fields,
        requiresConnection: 'telegram',
        connectionRef: 'ref-1',
      }),
    ).toBe('ready');
    expect(nodeReadiness({ parameters: { authMode: 'none' }, fields: deriveFields(schemaOf('webhook.trigger')) })).toBe(
      'ready',
    );
  });
});

describe('fieldValueToParam', () => {
  const f = (kind: FormField['kind'], required = true): FormField => ({
    name: 'x',
    label: 'X',
    kind,
    required,
  });

  test('coerces numbers and rejects non-numeric input', () => {
    expect(fieldValueToParam(f('number'), '42')).toBe(42);
    expect(fieldValueToParam(f('number', false), '')).toBeUndefined();
    expect(() => fieldValueToParam(f('number'), 'abc')).toThrow();
  });

  test('parses json and surfaces syntax errors', () => {
    expect(fieldValueToParam(f('json'), '{"a":1}')).toEqual({ a: 1 });
    expect(fieldValueToParam(f('json', false), '')).toBeUndefined();
    expect(() => fieldValueToParam(f('json'), '{nope')).toThrow();
  });

  test('passes booleans through and trims optional empty text to undefined', () => {
    expect(fieldValueToParam(f('boolean'), true)).toBe(true);
    expect(fieldValueToParam(f('text', false), '')).toBeUndefined();
    expect(fieldValueToParam(f('text'), '')).toBe('');
    expect(fieldValueToParam(f('select'), 'none')).toBe('none');
  });
});
