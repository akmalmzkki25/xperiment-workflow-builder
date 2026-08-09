import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { serviceAccountToken } from './jwt.js';

const paramsSchema = z
  .object({ spreadsheetId: z.string().min(1), range: z.string().min(1), values: z.array(z.unknown()) })
  .strict();
const DEFAULT_BASE = 'https://sheets.googleapis.com';

function connOf(payload: unknown) {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.googleSheets.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid googleSheets connection payload', false);
  return parsed.data;
}

export const sheetsAppendRow: ConnectorDefinition = {
  type: 'sheets.appendRow',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  display: {
    displayName: 'Append sheet row',
    description: 'Add a row to the bottom of a Google Sheet.',
    category: 'Integrations',
    glyph: '⊞',
  },
  paramsSchema,
  requiresConnection: 'googleSheets',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const token = await serviceAccountToken(conn, ctx.signal);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const url = `${base}/v4/spreadsheets/${encodeURIComponent(parsed.data.spreadsheetId)}/values/${encodeURIComponent(parsed.data.range)}:append?valueInputOption=USER_ENTERED`;
    const data = (await providerFetch(
      url,
      { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { values: [parsed.data.values] } },
      ctx.signal,
    )) as { updates?: { updatedRange?: string; updatedRows?: number } };
    return { output: { updatedRange: data.updates?.updatedRange ?? null, updatedRows: data.updates?.updatedRows ?? 0 } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    const token = await serviceAccountToken(conn, signal);
    if (conn.testSpreadsheetId) {
      const base = conn.baseUrl ?? DEFAULT_BASE;
      const res = await fetch(
        `${base}/v4/spreadsheets/${encodeURIComponent(conn.testSpreadsheetId)}?fields=spreadsheetId`,
        { headers: { authorization: `Bearer ${token}` }, signal },
      );
      if (!res.ok) throw new Error(`connection test failed (${res.status})`);
    }
  },
};
