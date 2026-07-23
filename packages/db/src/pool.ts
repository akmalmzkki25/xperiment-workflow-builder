import pg from 'pg';

export const DEFAULT_DATABASE_URL = 'postgres://xperiment:xperiment@localhost:5432/xperiment';
export const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

export type Db = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl?: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl ?? process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL,
    max: 10,
  });
}
