import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { providerFetch } from '../providers/http.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';
import { serviceAccountToken } from './jwt.js';

const paramsSchema = z.object({ spreadsheetId: z.string().min(1), range: z.string().min(1) }).strict();
const DEFAULT_BASE = 'https://sheets.googleapis.com';

function connOf(payload: unknown) {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.googleSheets.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid googleSheets connection payload', false);
  return parsed.data;
}

export const sheetsGetRows: ConnectorDefinition = {
  type: 'sheets.getRows',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'read',
  outputPorts: ['main'],
  display: {
    displayName: 'Read sheet rows',
    description: 'Read a block of cells from a Google Sheet as rows of raw cell values, header row included.',
    category: 'Integrations',
    glyph: '▦',
  },
  paramsSchema,
  requiresConnection: 'googleSheets',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const token = await serviceAccountToken(conn, ctx.signal);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const url = `${base}/v4/spreadsheets/${encodeURIComponent(parsed.data.spreadsheetId)}/values/${encodeURIComponent(parsed.data.range)}`;
    const data = (await providerFetch(
      url,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      ctx.signal,
    )) as { values?: unknown[] };
    return { output: { rows: data.values ?? [] } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    await serviceAccountToken(conn, signal);
  },
};
