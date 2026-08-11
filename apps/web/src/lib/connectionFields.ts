/**
 * Turns the server's connection payload schema into form fields.
 *
 * This file used to carry a hand-written copy of `CONNECTION_PAYLOAD_SCHEMAS`, and its
 * own docblock conceded it would drift. It had: `smtp.secure`, `googleSheets.baseUrl`
 * and `googleSheets.tokenUrl` all existed on the server and had no input here, so an
 * SMTP connection over implicit TLS was simply not expressible from the UI.
 *
 * What stays local is presentation only — which field is a secret, what a good
 * placeholder is, how a name reads in English. No JSON Schema carries any of that.
 */

export type FieldKind = 'text' | 'password' | 'number' | 'checkbox';

export interface ConnectionField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  placeholder?: string;
}

/** The subset of Draft-7 this form needs. Anything else is treated as text. */
export interface JsonSchemaLike {
  properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }> | undefined;
  required?: string[] | undefined;
}

/**
 * Field names that are NOT secret. Everything else is masked.
 *
 * An allowlist, not a denylist, and that direction is the point: when a connector adds a
 * credential this file has never heard of, the cost of the default is a masked field
 * somebody retypes. The cost of the other default is a live token rendered in plain text
 * on a shared screen.
 */
const PUBLIC_FIELDS = new Set([
  'baseUrl',
  'tokenUrl',
  'host',
  'port',
  'user',
  'from',
  'secure',
  'phoneNumberId',
  'serviceAccountEmail',
  'testSpreadsheetId',
]);

/** Words that read wrong when merely capitalised. */
const ACRONYMS: Record<string, string> = { url: 'URL', api: 'API', id: 'ID', smtp: 'SMTP', tls: 'TLS' };

/** Labels a human wrote better than the derivation can. */
const LABEL_OVERRIDES: Record<string, string> = {
  privateKey: 'Service account private key',
  secure: 'Use implicit TLS (port 465)',
  from: 'From address',
};

const PLACEHOLDERS: Record<string, string> = {
  'postgres.connectionString': 'postgres://user:pass@host:5432/db',
  'telegram.baseUrl': 'https://api.telegram.org',
  'openai.baseUrl': 'https://api.openai.com',
  'gemini.baseUrl': 'https://generativelanguage.googleapis.com',
  'whatsapp.baseUrl': 'https://graph.facebook.com',
  'googleSheets.baseUrl': 'https://sheets.googleapis.com',
  'smtp.host': 'smtp.gmail.com',
  'smtp.port': '587',
  'smtp.from': 'bot@example.com',
};

/** `serviceAccountEmail` -> `Service account email`, `apiKey` -> `API key`. */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  if (words.length === 0) return name;
  return words
    .map((word, i) => {
      const acronym = ACRONYMS[word];
      if (acronym !== undefined) return acronym;
      // Sentence case, not title case: "Phone number ID" reads as a label, "Phone Number
      // ID" reads as a heading.
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

function isBooleanish(prop: { type?: string; anyOf?: { type?: string }[] }): boolean {
  // `smtp.secure` is a union of a real boolean and the string "true"/"false" the form
  // used to submit, so it arrives as anyOf rather than a plain boolean.
  return prop.type === 'boolean' || (prop.anyOf ?? []).some((a) => a.type === 'boolean');
}

function kindOf(name: string, prop: { type?: string; anyOf?: { type?: string }[] }): FieldKind {
  if (!PUBLIC_FIELDS.has(name)) return 'password';
  if (isBooleanish(prop)) return 'checkbox';
  if (prop.type === 'integer' || prop.type === 'number') return 'number';
  return 'text';
}

/** Declaration order is kept: the server schemas are already written in reading order. */
export function deriveFields(connectorKey: string, schema: JsonSchemaLike): ConnectionField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const placeholder = PLACEHOLDERS[`${connectorKey}.${name}`];
    return {
      name,
      label: LABEL_OVERRIDES[name] ?? humanizeFieldName(name),
      kind: kindOf(name, prop),
      required: required.has(name),
      ...(placeholder === undefined ? {} : { placeholder }),
    };
  });
}

/**
 * Assemble the payload the API expects.
 *
 * An unchecked checkbox is omitted rather than sent as `false`: every boolean here is
 * optional, and sending an explicit false where the author meant "leave it alone" is the
 * kind of difference that only shows up against a real provider.
 */
export function buildPayload(
  fields: readonly ConnectionField[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim();
    if (field.kind === 'checkbox') {
      if (raw === 'true') payload[field.name] = true;
      continue;
    }
    if (raw === '') {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    payload[field.name] = field.kind === 'number' ? Number(raw) : raw;
  }
  return payload;
}
