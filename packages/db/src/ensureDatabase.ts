import pg from 'pg';

/**
 * Create a database if it is not there yet.
 *
 * Exists for the test suite. `docker-compose.yml` creates `xperiment` through
 * `POSTGRES_DB`, but that only runs once, on an empty data directory — and the volume is
 * named and long-lived, so a second database added to the compose file would never appear
 * for anyone who already has the stack. Creating it at run time is the only version that
 * works on a machine that is already set up.
 *
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT EXISTS`, so this
 * checks first and treats a concurrent creation (42P04) as success — two packages' test
 * runs can start at the same moment.
 */
export async function ensureDatabaseExists(databaseUrl: string): Promise<'created' | 'existed'> {
  const target = new URL(databaseUrl);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!name) throw new Error(`no database name in ${target.host}${target.pathname}`);

  // Connect to the maintenance database instead: you cannot create a database from a
  // connection to the database you are creating.
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 1) return 'existed';
    try {
      // Identifiers cannot be parameterised. The name comes from a URL the operator set,
      // and is quoted, so a name containing a quote is rejected rather than concatenated.
      if (name.includes('"')) throw new Error(`refusing to create a database named ${name}`);
      await client.query(`CREATE DATABASE "${name}"`);
      return 'created';
    } catch (error) {
      // 42P04 duplicate_database: another runner won the race, which is the outcome asked
      // for.
      if ((error as { code?: string }).code === '42P04') return 'existed';
      throw error;
    }
  } finally {
    await client.end();
  }
}
