/**
 * Client-side field maps for connection payloads (CONNECTION_PAYLOAD_SCHEMAS
 * on the server is the source of truth). Secret fields render as password
 * inputs and are never echoed back after creation.
 */

export interface ConnectionField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
}

export const CONNECTION_FIELDS: Record<string, ConnectionField[]> = {
  postgres: [
    {
      name: 'connectionString',
      label: 'Connection string',
      secret: true,
      required: true,
      placeholder: 'postgres://user:pass@host:5432/db',
    },
  ],
  telegram: [
    { name: 'botToken', label: 'Bot token', secret: true, required: true },
    { name: 'baseUrl', label: 'Base URL', secret: false, required: false, placeholder: 'https://api.telegram.org' },
  ],
  openai: [
    { name: 'apiKey', label: 'API key', secret: true, required: true },
    { name: 'baseUrl', label: 'Base URL', secret: false, required: false, placeholder: 'https://api.openai.com' },
  ],
  gemini: [
    { name: 'apiKey', label: 'API key', secret: true, required: true },
    {
      name: 'baseUrl',
      label: 'Base URL',
      secret: false,
      required: false,
      placeholder: 'https://generativelanguage.googleapis.com',
    },
  ],
};

export const CONNECTOR_KEYS = Object.keys(CONNECTION_FIELDS);

export function buildPayload(connectorKey: string, values: Record<string, string>): Record<string, unknown> {
  const fields = CONNECTION_FIELDS[connectorKey];
  if (!fields) throw new Error(`Unknown connector key: ${connectorKey}`);
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim();
    if (raw === '') {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    payload[field.name] = raw;
  }
  return payload;
}
