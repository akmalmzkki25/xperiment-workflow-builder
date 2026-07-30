import type pg from 'pg';
import { withTx } from '../tx.js';
import { ENC_VERSION_LEGACY, type SecretVault } from './vault.js';

const DEFAULT_BATCH_SIZE = 100;

/**
 * The encrypted columns, with the vault family each belongs to. Table and column names
 * are interpolated into the SQL below; every value here is a compile-time literal in a
 * frozen array, never user input.
 */
const TARGETS = [
  { table: 'connections', blob: 'encrypted_payload', version: 'enc_version', family: 'credentials' },
  { table: 'workflow_triggers', blob: 'secret_encrypted', version: 'secret_enc_version', family: 'trigger' },
  {
    table: 'workflows',
    blob: 'completion_webhook_secret_encrypted',
    version: 'completion_webhook_enc_version',
    family: 'trigger',
  },
  {
    table: 'alert_rules',
    blob: 'webhook_secret_encrypted',
    version: 'webhook_secret_enc_version',
    family: 'trigger',
  },
] as const;

export interface RekeyProgress {
  table: string;
  rekeyed: number;
  remaining: number;
}

/**
 * Moves every enc_version = 0 secret to the envelope format. A SQL migration cannot do
 * this: the legacy keys live in the application environment, not the database.
 *
 * Each row is re-keyed in its own transaction with a compare-and-set on the version
 * column, which makes the job resumable, idempotent, and safe to run against live
 * traffic. Interrupting it leaves a mixed state both read paths already handle.
 *
 * No raw key is passed in. Each vault already decrypts v0 through the legacy key it was
 * constructed with, so this reads and writes entirely through the vault interface. A
 * vault built with the wrong legacy key fails on the first row of its table — loud, and
 * before anything has been rewritten.
 */
export async function rekeyAll(args: {
  pool: pg.Pool;
  credentialsVault: SecretVault;
  triggerVault: SecretVault;
  batchSize?: number;
}): Promise<RekeyProgress[]> {
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;
  const out: RekeyProgress[] = [];

  for (const t of TARGETS) {
    const vault = t.family === 'credentials' ? args.credentialsVault : args.triggerVault;
    let rekeyed = 0;

    for (;;) {
      const batch = await args.pool.query<{ id: string; workspace_id: string; blob: Buffer }>(
        `SELECT id, workspace_id, ${t.blob} AS blob FROM ${t.table}
          WHERE ${t.version} = $1 AND ${t.blob} IS NOT NULL
          ORDER BY id
          LIMIT $2`,
        [ENC_VERSION_LEGACY, batchSize],
      );
      if (batch.rows.length === 0) break;

      for (const row of batch.rows) {
        const plaintext = await vault.decrypt(row.workspace_id, {
          blob: row.blob,
          encVersion: ENC_VERSION_LEGACY,
        });
        const sealed = await vault.encrypt(row.workspace_id, plaintext);
        const updated = await withTx(args.pool, async (client) =>
          client.query(
            `UPDATE ${t.table} SET ${t.blob} = $1, ${t.version} = $2
              WHERE id = $3 AND ${t.version} = $4`,
            [sealed.blob, sealed.encVersion, row.id, ENC_VERSION_LEGACY],
          ),
        );
        // A concurrent writer may already have moved this row; that is not an error.
        if ((updated.rowCount ?? 0) > 0) rekeyed += 1;
      }
      if (batch.rows.length < batchSize) break;
    }

    const left = await args.pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM ${t.table} WHERE ${t.version} = $1 AND ${t.blob} IS NOT NULL`,
      [ENC_VERSION_LEGACY],
    );
    out.push({ table: t.table, rekeyed, remaining: Number(left.rows[0]!.c) });
  }

  return out;
}
