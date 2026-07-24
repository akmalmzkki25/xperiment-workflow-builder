/**
 * Derives renderable form fields from the draft-7 JSON Schemas served by
 * GET /v1/connectors. Only the shapes zod-to-json-schema emits for our
 * connector params are handled; anything unrecognized falls back to `json`.
 */

export interface FormField {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'select' | 'json';
  required: boolean;
  options?: string[];
  description?: string;
}

interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  description?: string;
  default?: unknown;
}

function asObjectSchema(schema: unknown): JsonSchemaNode | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const s = schema as JsonSchemaNode;
  if (s.type !== 'object' || typeof s.properties !== 'object' || s.properties === null) return null;
  return s;
}

export function humanizeName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldKind(prop: JsonSchemaNode): FormField['kind'] {
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === 'string')) return 'select';
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (type === 'string') return 'text';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'json';
}

export function deriveFields(paramsJsonSchema: unknown): FormField[] {
  const schema = asObjectSchema(paramsJsonSchema);
  if (!schema) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]): FormField => {
    const kind = fieldKind(prop);
    return {
      name,
      label: humanizeName(name),
      kind,
      required: required.has(name),
      ...(kind === 'select' ? { options: (prop.enum ?? []).map(String) } : {}),
      ...(prop.description ? { description: prop.description } : {}),
    };
  });
}

export function defaultParams(paramsJsonSchema: unknown): Record<string, unknown> {
  const schema = asObjectSchema(paramsJsonSchema);
  if (!schema) return {};
  const required = new Set(schema.required ?? []);
  const params: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) {
      params[name] = prop.default;
      continue;
    }
    if (!required.has(name)) continue;
    const kind = fieldKind(prop);
    if (kind === 'select') params[name] = String(prop.enum?.[0] ?? '');
    else if (kind === 'text') params[name] = '';
    else if (kind === 'boolean') params[name] = false;
    else if (kind === 'json') params[name] = {};
    // required numbers stay unset until the user types one
  }
  return params;
}

export type NodeReadiness = 'needs-connection' | 'needs-config' | 'ready';

export function nodeReadiness(args: {
  parameters: Record<string, unknown>;
  fields: FormField[];
  requiresConnection?: string;
  connectionRef?: string;
}): NodeReadiness {
  if (args.requiresConnection && !args.connectionRef) return 'needs-connection';
  for (const field of args.fields) {
    if (!field.required) continue;
    const value = args.parameters[field.name];
    if (value === undefined || value === '') return 'needs-config';
  }
  return 'ready';
}

export function fieldValueToParam(field: FormField, raw: string | boolean): unknown {
  if (field.kind === 'boolean') return raw === true;
  const text = typeof raw === 'string' ? raw : String(raw);
  if (field.kind === 'number') {
    if (text.trim() === '') return undefined;
    const n = Number(text);
    if (Number.isNaN(n)) throw new Error(`${field.label} must be a number`);
    return n;
  }
  if (field.kind === 'json') {
    if (text.trim() === '') return undefined;
    return JSON.parse(text) as unknown;
  }
  if (text === '' && !field.required) return undefined;
  return text;
}
