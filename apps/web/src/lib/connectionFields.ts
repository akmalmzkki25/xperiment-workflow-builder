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
  whatsapp: [
    { name: 'accessToken', label: 'Access token', secret: true, required: true },
    { name: 'phoneNumberId', label: 'Phone number ID', secret: false, required: true },
    { name: 'baseUrl', label: 'Base URL', secret: false, required: false, placeholder: 'https://graph.facebook.com' },
  ],
  smtp: [
    { name: 'host', label: 'SMTP host', secret: false, required: true, placeholder: 'smtp.gmail.com' },
    { name: 'port', label: 'Port', secret: false, required: true, placeholder: '587' },
    { name: 'user', label: 'Username', secret: false, required: true },
    { name: 'password', label: 'Password', secret: true, required: true },
    { name: 'from', label: 'From address', secret: false, required: true, placeholder: 'bot@example.com' },
  ],
  googleSheets: [
    { name: 'serviceAccountEmail', label: 'Service account email', secret: false, required: true },
    { name: 'privateKey', label: 'Service account private key', secret: true, required: true },
    { name: 'testSpreadsheetId', label: 'Test spreadsheet ID', secret: false, required: false },
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
