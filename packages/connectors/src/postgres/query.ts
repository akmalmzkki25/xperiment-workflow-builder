import pg from 'pg';
import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z.object({ sql: z.string().min(1), params: z.array(z.unknown()).optional() }).strict();

function client(payload: unknown): pg.Client {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.postgres.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid postgres connection payload', false);
  return new pg.Client({ connectionString: parsed.data.connectionString, connectionTimeoutMillis: 10000 });
}

export const postgresQuery: ConnectorDefinition = {
  type: 'postgres.query',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'read',
  outputPorts: ['main'],
  display: {
    displayName: 'Postgres query',
    description: 'Run a parameterised SQL query against Postgres.',
    category: 'Integrations',
    glyph: '▤',
  },
  paramsSchema,
  requiresConnection: 'postgres',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const c = client(ctx.connection);
    try {
      await c.connect();
    } catch {
      throw new NodeRunError('network_error', 'database connection failed', true);
    }
    try {
      const result = await c.query(parsed.data.sql, (parsed.data.params ?? []) as unknown[]);
      return { output: { rows: result.rows as unknown[], rowCount: result.rowCount ?? 0 } };
    } catch (e) {
      throw new NodeRunError('query_error', (e as Error).message, false);
    } finally {
      await c.end().catch(() => {});
    }
  },
  async testConnection(payload) {
    const c = client(payload);
    try {
      await c.connect();
      await c.query('SELECT 1');
    } finally {
      await c.end().catch(() => {});
    }
  },
};
