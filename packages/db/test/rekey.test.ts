import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, deriveLegacyKey, encryptSecret, runMigrations } from '../src/index.js';
import { localKeyProvider } from '../src/crypto/keyProvider.js';
import { createWorkspaceKeyring } from '../src/crypto/keyring.js';
import { createSecretVault, type SecretVault } from '../src/crypto/vault.js';
import { rekeyAll } from '../src/crypto/rekey.js';

let pool: Pool;
let ws: string;
let credentialsVault: SecretVault;
let triggerVault: SecretVault;

const legacyCredentials = deriveLegacyKey('legacy-credentials');
const legacyTrigger = deriveLegacyKey('legacy-trigger');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE connections, workflow_triggers, alert_rules, alert_events, workflow_versions,
              workflow_drafts, workflows, workspace_keys, audit_events CASCADE`,
  );
  ws = randomUUID();
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'rekey')`, [ws]);
  const keyring = createWorkspaceKeyring({ pool, provider: localKeyProvider('rekey-test-master') });
  credentialsVault = createSecretVault({ keyring, legacyKey: legacyCredentials });
  triggerVault = createSecretVault({ keyring, legacyKey: legacyTrigger });
});

/** Seeds one legacy row in each of the four encrypted columns. */
async function seedLegacy(): Promise<{ connectionId: string; workflowId: string; ruleId: string }> {
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
     VALUES ($1,'telegram','C',$2,0) RETURNING id`,
    [ws, encryptSecret('{"botToken":"legacy-bot"}', legacyCredentials)],
  );
  const wf = await pool.query<{ id: string }>(
    `INSERT INTO workflows (workspace_id, name, completion_webhook_url,
       completion_webhook_secret_encrypted, completion_webhook_enc_version)
     VALUES ($1,'W','https://example.com/cb',$2,0) RETURNING id`,
    [ws, encryptSecret('legacy-callback', legacyTrigger)],
  );
  await pool.query(
    `INSERT INTO workflow_triggers (workspace_id, workflow_id, node_id, type, route_key, auth_mode,
       secret_encrypted, secret_enc_version)
     VALUES ($1,$2,'n1','webhook',$3,'token',$4,0)`,
    [ws, wf.rows[0]!.id, randomUUID(), encryptSecret('legacy-trigger-secret', legacyTrigger)],
  );
  const rule = await pool.query<{ id: string }>(
    `INSERT INTO alert_rules (workspace_id, name, type, params, webhook_url,
       webhook_secret_encrypted, webhook_secret_enc_version)
     VALUES ($1,'R','failure_rate','{}','https://example.com/a',$2,0) RETURNING id`,
    [ws, encryptSecret('legacy-alert-secret', legacyTrigger)],
  );
  return { connectionId: conn.rows[0]!.id, workflowId: wf.rows[0]!.id, ruleId: rule.rows[0]!.id };
}

describe('rekeyAll', () => {
  test('re-keys all four columns to v1 with the plaintext unchanged', async () => {
    const seeded = await seedLegacy();
    const progress = await rekeyAll({ pool, credentialsVault, triggerVault });
    expect(progress.map((p) => p.table).sort()).toEqual([
      'alert_rules',
      'connections',
      'workflow_triggers',
      'workflows',
    ]);
    for (const p of progress) {
      expect(p.rekeyed, p.table).toBe(1);
      expect(p.remaining, p.table).toBe(0);
    }

    const conn = await pool.query<{ encrypted_payload: Buffer; enc_version: number }>(
      `SELECT encrypted_payload, enc_version FROM connections WHERE id = $1`,
      [seeded.connectionId],
    );
    expect(conn.rows[0]!.enc_version).toBe(1);
    expect(await credentialsVault.decrypt(ws, { blob: conn.rows[0]!.encrypted_payload, encVersion: 1 })).toBe(
      '{"botToken":"legacy-bot"}',
    );

    const trg = await pool.query<{ secret_encrypted: Buffer; secret_enc_version: number }>(
      `SELECT secret_encrypted, secret_enc_version FROM workflow_triggers WHERE workflow_id = $1`,
      [seeded.workflowId],
    );
    expect(trg.rows[0]!.secret_enc_version).toBe(1);
    expect(await triggerVault.decrypt(ws, { blob: trg.rows[0]!.secret_encrypted, encVersion: 1 })).toBe(
      'legacy-trigger-secret',
    );

    const cb = await pool.query<{ completion_webhook_secret_encrypted: Buffer }>(
      `SELECT completion_webhook_secret_encrypted FROM workflows WHERE id = $1`,
      [seeded.workflowId],
    );
    expect(await triggerVault.decrypt(ws, { blob: cb.rows[0]!.completion_webhook_secret_encrypted, encVersion: 1 })).toBe(
      'legacy-callback',
    );

    const rule = await pool.query<{ webhook_secret_encrypted: Buffer }>(
      `SELECT webhook_secret_encrypted FROM alert_rules WHERE id = $1`,
      [seeded.ruleId],
    );
    expect(await triggerVault.decrypt(ws, { blob: rule.rows[0]!.webhook_secret_encrypted, encVersion: 1 })).toBe(
      'legacy-alert-secret',
    );
  });

  test('the credentials and trigger families are not crossed', async () => {
    // Each column must be re-keyed through the vault holding the legacy key it was
    // written under. Crossing them would decrypt with the wrong key and throw, so a
    // clean run over all four columns is itself the assertion.
    await seedLegacy();
    const progress = await rekeyAll({ pool, credentialsVault, triggerVault });
    expect(progress.every((p) => p.rekeyed === 1)).toBe(true);
  });

  test('a second run is a no-op', async () => {
    await seedLegacy();
    await rekeyAll({ pool, credentialsVault, triggerVault });
    const again = await rekeyAll({ pool, credentialsVault, triggerVault });
    for (const p of again) {
      expect(p.rekeyed, p.table).toBe(0);
      expect(p.remaining, p.table).toBe(0);
    }
  });

  test('batching drains every row across multiple pages', async () => {
    // batchSize is a page size, not a total cap: the loop keeps paging until a page
    // comes back short. Three rows at batchSize 1 must all finish in one call.
    await seedLegacy();
    for (const n of ['C2', 'C3']) {
      await pool.query(
        `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
         VALUES ($1,'telegram',$2,$3,0)`,
        [ws, n, encryptSecret(`{"botToken":"${n}"}`, legacyCredentials)],
      );
    }
    const progress = await rekeyAll({ pool, credentialsVault, triggerVault, batchSize: 1 });
    const conns = progress.find((p) => p.table === 'connections')!;
    expect(conns.rekeyed).toBe(3);
    expect(conns.remaining).toBe(0);
    const versions = await pool.query<{ enc_version: number }>(`SELECT enc_version FROM connections`);
    expect(versions.rows.every((r) => r.enc_version === 1)).toBe(true);
  });

  test('a mixed state reads correctly and a later run finishes it', async () => {
    // The guarantee the rollout depends on: while the backfill is incomplete, v0 and v1
    // rows coexist and every one of them is readable through the same vault.
    await seedLegacy();
    await rekeyAll({ pool, credentialsVault, triggerVault });
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','C2',$2,0)`,
      [ws, encryptSecret('{"botToken":"second"}', legacyCredentials)],
    );
    const rows = await pool.query<{ encrypted_payload: Buffer; enc_version: number }>(
      `SELECT encrypted_payload, enc_version FROM connections ORDER BY name`,
    );
    expect(rows.rows.map((r) => r.enc_version).sort()).toEqual([0, 1]);
    const decrypted = await Promise.all(
      rows.rows.map((r) => credentialsVault.decrypt(ws, { blob: r.encrypted_payload, encVersion: r.enc_version })),
    );
    expect(decrypted.sort()).toEqual(['{"botToken":"legacy-bot"}', '{"botToken":"second"}']);
    // Resuming picks up only what is left.
    const second = await rekeyAll({ pool, credentialsVault, triggerVault });
    const conns = second.find((p) => p.table === 'connections')!;
    expect(conns.rekeyed).toBe(1);
    expect(conns.remaining).toBe(0);
  });

  test('rows with a NULL secret are not counted and not touched', async () => {
    await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1, 'NoCallback')`, [ws]);
    const progress = await rekeyAll({ pool, credentialsVault, triggerVault });
    expect(progress.find((p) => p.table === 'workflows')!.rekeyed).toBe(0);
    const row = await pool.query<{ completion_webhook_enc_version: number }>(
      `SELECT completion_webhook_enc_version FROM workflows WHERE name = 'NoCallback'`,
    );
    expect(row.rows[0]!.completion_webhook_enc_version).toBe(0);
  });

  test('a row that cannot be decrypted stops the run rather than being skipped', async () => {
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','Corrupt',$2,0)`,
      [ws, Buffer.alloc(40, 3)],
    );
    await expect(rekeyAll({ pool, credentialsVault, triggerVault })).rejects.toThrow();
    const still = await pool.query<{ enc_version: number }>(`SELECT enc_version FROM connections`);
    expect(still.rows[0]!.enc_version).toBe(0); // untouched
  });

  test('re-keys rows across several workspaces, each under its own key', async () => {
    const other = randomUUID();
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'rekey2')`, [other]);
    await seedLegacy();
    await pool.query(
      `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload, enc_version)
       VALUES ($1,'telegram','Other',$2,0)`,
      [other, encryptSecret('{"botToken":"other-ws"}', legacyCredentials)],
    );
    await rekeyAll({ pool, credentialsVault, triggerVault });
    const rows = await pool.query<{ workspace_id: string; encrypted_payload: Buffer }>(
      `SELECT workspace_id, encrypted_payload FROM connections ORDER BY name`,
    );
    // Each blob decrypts only under its own workspace, proving the AAD moved with it.
    for (const r of rows.rows) {
      await expect(
        credentialsVault.decrypt(r.workspace_id, { blob: r.encrypted_payload, encVersion: 1 }),
      ).resolves.toContain('botToken');
      const wrong = r.workspace_id === ws ? other : ws;
      await expect(credentialsVault.decrypt(wrong, { blob: r.encrypted_payload, encVersion: 1 })).rejects.toThrow();
    }
  });
});
