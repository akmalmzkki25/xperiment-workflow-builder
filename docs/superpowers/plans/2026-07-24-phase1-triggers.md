# Phase 1 Sub-project A: Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Webhook + schedule triggers: external systems and cron start executions through a new gateway (:3003) and scheduler (:3004), gated by workflow activation.

**Architecture:** Extends the Phase 0 monorepo. New migration + triggers repository + AES-GCM secret helper in `@xperiment/db`; two new trigger connector types; activation endpoints in `@xperiment/api`; two new thin services following the established pattern (tsx entry, pino, healthz, outbox publisher). Spec: `docs/superpowers/specs/2026-07-24-phase1-triggers-design.md`.

**Tech Stack:** Existing stack + `cron-parser` ^4.9.0 (in `@xperiment/engine-core` for next-fire math and `@xperiment/connectors` for IR validation).

## Global Constraints

- All Phase 0 global constraints still apply (TDD, 80% coverage thresholds, strict TS, ESM `main: ./src/index.ts`, serial test runs, conventional commits, no secrets in logs/IR).
- New node types (exact): `webhook.trigger`, `schedule.trigger`; `operationVersion` `"0.1.0"`.
- `TRIGGER_SECRET_KEY` env: any string ≥ 16 chars; the 32-byte AES key is `sha256(TRIGGER_SECRET_KEY)`. Dev default in `.env.example`: `xperiment-dev-trigger-secret-change-me`.
- Gateway URL shapes (exact): production `POST /t/:routeKey`, test `POST /t/test/:routeKey`; `route_key` is 24 random bytes base64url.
- Auth headers (exact): token → `Authorization: Bearer <secret>`; hmac → `X-Xperiment-Signature: sha256=<hex(hmac-sha256(secret, rawBody))>`.
- Scheduler idempotency key (exact): `sched:{triggerId}:{scheduledFor.toISOString()}`; misfire grace 60000 ms (skip forward, never catch up).
- Env vars: `GATEWAY_PORT` (3003), `SCHEDULER_PORT` (3004), `SCHEDULER_INTERVAL_MS` (5000), `GATEWAY_URL` (`http://localhost:3003`). E2E uses ports 3103 (gateway) / 3104 (scheduler) with `SCHEDULER_INTERVAL_MS=500`.
- Body cap 1 MB at the gateway. Stored webhook payload shape: `{ body, headers, query }` with `authorization`, `cookie`, `x-xperiment-signature` headers removed.

## File Structure

```text
packages/db/src/crypto.ts                    # encryptSecret/decryptSecret (AES-256-GCM)
packages/db/src/migrations/0002_triggers.sql
packages/db/src/repos/triggers.ts            # trigger rows, due-lease query, samples
packages/engine-core/src/cron.ts             # nextFireAt(cron, tz, from)
packages/connectors/src/webhook/trigger.ts   # webhook.trigger
packages/connectors/src/schedule/trigger.ts  # schedule.trigger (cron/tz zod refines)
apps/api/src/routes/triggers.ts              # activate/deactivate/list/samples
apps/gateway/src/{verify,server,main}.ts     # verification helpers + fast-ack routes
apps/scheduler/src/{tick,main}.ts            # lease tick + service loop
e2e/test/triggers.test.ts                    # end-to-end trigger scenarios
```

---

### Task 1: DB — secret crypto, migration 0002, triggers repository

**Files:**
- Create: `packages/db/src/crypto.ts`, `src/migrations/0002_triggers.sql`, `src/repos/triggers.ts`
- Modify: `packages/db/src/index.ts` (add exports)
- Test: `packages/db/test/crypto.test.ts`, `packages/db/test/triggers.test.ts`

**Interfaces:**
- Consumes: `Db`, `withTx`, `DEFAULT_WORKSPACE_ID`, existing repos.
- Produces:
  - `deriveTriggerKey(envValue: string): Buffer` (sha256), `encryptSecret(plaintext: string, key: Buffer): Buffer` (iv‖tag‖ciphertext), `decryptSecret(buf: Buffer, key: Buffer): string` (throws on tamper)
  - `interface TriggerRow { id; workflowId; nodeId; type: 'webhook' | 'schedule'; routeKey; authMode: string | null; idempotencyKeyPath: string | null; cron: string | null; timezone: string | null; nextFireAt: string | null; active: boolean; secretEncrypted: Buffer | null }`
  - `upsertTrigger(db, args: { workflowId; nodeId; type; authMode?; idempotencyKeyPath?; cron?; timezone?; nextFireAt?: Date | null; secretEncrypted?: Buffer | null }): Promise<TriggerRow>` — `ON CONFLICT (workflow_id, node_id) DO UPDATE` refreshing config but PRESERVING `route_key` and `secret_encrypted` (only sets secret when the existing one is NULL)
  - `getTriggerByRouteKey(db, routeKey): Promise<TriggerRow | null>`
  - `listTriggers(db, workflowId): Promise<TriggerRow[]>`
  - `setTriggersActive(db, workflowId, active): Promise<void>` + `setWorkflowActive(db, workflowId, active): Promise<void>`
  - `deleteTriggersNotIn(db, workflowId, nodeIds: string[]): Promise<void>`
  - `dueScheduleTriggers(client: pg.PoolClient, limit): Promise<TriggerRow[]>` — `FOR UPDATE SKIP LOCKED`
  - `updateNextFireAt(db, triggerId, nextFireAt: Date): Promise<void>`
  - `recentTestTriggerPayloads(db, workflowId, limit): Promise<unknown[]>` — payloads of trigger_events whose executions have `mode = 'test'`, newest first

- [ ] **Step 1: Write failing tests**

`packages/db/test/crypto.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { decryptSecret, deriveTriggerKey, encryptSecret } from '../src/crypto.js';

describe('trigger secret crypto', () => {
  const key = deriveTriggerKey('xperiment-dev-trigger-secret-change-me');

  test('derives a 32-byte key from any string', () => {
    expect(key.length).toBe(32);
    expect(deriveTriggerKey('other').equals(key)).toBe(false);
  });

  test('round-trips a secret with unique ciphertexts', () => {
    const a = encryptSecret('s3cret-value', key);
    const b = encryptSecret('s3cret-value', key);
    expect(decryptSecret(a, key)).toBe('s3cret-value');
    expect(decryptSecret(b, key)).toBe('s3cret-value');
    expect(a.equals(b)).toBe(false); // random IV
  });

  test('rejects tampered ciphertext and wrong key', () => {
    const buf = encryptSecret('x', key);
    const tampered = Buffer.from(buf);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptSecret(tampered, key)).toThrow();
    expect(() => decryptSecret(buf, deriveTriggerKey('wrong'))).toThrow();
  });
});
```

`packages/db/test/triggers.test.ts` (integration; standard beforeAll/beforeEach truncate pattern from `test/workflows.test.ts` — copy it, plus create a workflow in beforeEach):

```ts
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, runMigrations, withTx } from '../src/index.js';
import { createExecutionWithTrigger } from '../src/repos/executions.js';
import {
  deleteTriggersNotIn,
  dueScheduleTriggers,
  getTriggerByRouteKey,
  listTriggers,
  recentTestTriggerPayloads,
  setTriggersActive,
  setWorkflowActive,
  updateNextFireAt,
  upsertTrigger,
} from '../src/repos/triggers.js';
import { createVersion, createWorkflow, getWorkflow } from '../src/repos/workflows.js';

let pool: Pool;
let workflowId: string;
let versionId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  const wf = await createWorkflow(pool, { name: 'T' });
  workflowId = wf.id;
  versionId = (await createVersion(pool, { workflowId, definition: {}, hash: 'h' })).id;
});

describe('triggers repo', () => {
  test('upsert creates a webhook row with route key, preserves it on re-upsert', async () => {
    const first = await upsertTrigger(pool, {
      workflowId,
      nodeId: 'hook',
      type: 'webhook',
      authMode: 'hmac',
      secretEncrypted: Buffer.from('enc-1'),
    });
    expect(first.routeKey.length).toBeGreaterThanOrEqual(24);
    const again = await upsertTrigger(pool, {
      workflowId,
      nodeId: 'hook',
      type: 'webhook',
      authMode: 'token',
      secretEncrypted: Buffer.from('enc-2'),
    });
    expect(again.id).toBe(first.id);
    expect(again.routeKey).toBe(first.routeKey); // preserved
    expect(again.secretEncrypted?.toString()).toBe('enc-1'); // preserved when present
    expect(again.authMode).toBe('token'); // config refreshed
  });

  test('lookup by route key and workflow listing', async () => {
    const row = await upsertTrigger(pool, { workflowId, nodeId: 'hook', type: 'webhook', authMode: 'none' });
    expect((await getTriggerByRouteKey(pool, row.routeKey))?.id).toBe(row.id);
    expect(await getTriggerByRouteKey(pool, 'nope')).toBeNull();
    expect(await listTriggers(pool, workflowId)).toHaveLength(1);
  });

  test('activation flags and pruning removed nodes', async () => {
    await upsertTrigger(pool, { workflowId, nodeId: 'a', type: 'webhook', authMode: 'none' });
    await upsertTrigger(pool, { workflowId, nodeId: 'b', type: 'schedule', cron: '* * * * *', timezone: 'UTC' });
    await setTriggersActive(pool, workflowId, true);
    await setWorkflowActive(pool, workflowId, true);
    expect((await listTriggers(pool, workflowId)).every((t) => t.active)).toBe(true);
    const wf = await getWorkflow(pool, workflowId);
    expect((wf as unknown as { active?: boolean }).active ?? true).toBeTruthy();
    await deleteTriggersNotIn(pool, workflowId, ['a']);
    const remaining = await listTriggers(pool, workflowId);
    expect(remaining.map((t) => t.nodeId)).toEqual(['a']);
  });

  test('due schedule triggers use SKIP LOCKED: second tx sees nothing', async () => {
    await upsertTrigger(pool, {
      workflowId,
      nodeId: 's',
      type: 'schedule',
      cron: '* * * * *',
      timezone: 'UTC',
      nextFireAt: new Date(Date.now() - 1000),
    });
    await setTriggersActive(pool, workflowId, true);
    await withTx(pool, async (c1: PoolClient) => {
      const due1 = await dueScheduleTriggers(c1, 10);
      expect(due1).toHaveLength(1);
      await withTx(pool, async (c2: PoolClient) => {
        const due2 = await dueScheduleTriggers(c2, 10);
        expect(due2).toHaveLength(0); // locked by c1
      });
    });
  });

  test('updateNextFireAt moves a trigger out of the due set', async () => {
    const row = await upsertTrigger(pool, {
      workflowId,
      nodeId: 's',
      type: 'schedule',
      cron: '* * * * *',
      timezone: 'UTC',
      nextFireAt: new Date(Date.now() - 1000),
    });
    await setTriggersActive(pool, workflowId, true);
    await updateNextFireAt(pool, row.id, new Date(Date.now() + 3600_000));
    await withTx(pool, async (c) => {
      expect(await dueScheduleTriggers(c, 10)).toHaveLength(0);
    });
  });

  test('recentTestTriggerPayloads returns only test-mode payloads, newest first', async () => {
    for (const [i, mode] of [
      [0, 'test'],
      [1, 'production'],
      [2, 'test'],
    ] as const) {
      const { execution } = await createExecutionWithTrigger(pool, {
        workflowId,
        versionId,
        idempotencyKey: `s-${i}`,
        payload: { n: i },
        nodeIds: ['t'],
        executionTimeoutMs: 60000,
      });
      await pool.query(`UPDATE executions SET mode = $1 WHERE id = $2`, [mode, execution.id]);
    }
    const samples = await recentTestTriggerPayloads(pool, workflowId, 5);
    expect(samples).toEqual([{ n: 2 }, { n: 0 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @xperiment/db test`
Expected: FAIL — `src/crypto.js` / `src/repos/triggers.js` not found.

- [ ] **Step 3: Implement crypto, migration, repo**

`packages/db/src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export function deriveTriggerKey(envValue: string): Buffer {
  return createHash('sha256').update(envValue).digest();
}

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(buf: Buffer, key: Buffer): string {
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

`packages/db/src/migrations/0002_triggers.sql`:

```sql
ALTER TABLE workflows ADD COLUMN active BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE workflow_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  route_key TEXT NOT NULL UNIQUE,
  auth_mode TEXT NULL,
  secret_encrypted BYTEA NULL,
  idempotency_key_path TEXT NULL,
  cron TEXT NULL,
  timezone TEXT NULL,
  next_fire_at TIMESTAMPTZ NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, node_id)
);
CREATE INDEX idx_workflow_triggers_due
  ON workflow_triggers (next_fire_at) WHERE active AND type = 'schedule';
```

`packages/db/src/repos/triggers.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { DEFAULT_WORKSPACE_ID, type Db } from '../pool.js';

export interface TriggerRow {
  id: string;
  workflowId: string;
  nodeId: string;
  type: 'webhook' | 'schedule';
  routeKey: string;
  authMode: string | null;
  idempotencyKeyPath: string | null;
  cron: string | null;
  timezone: string | null;
  nextFireAt: string | null;
  active: boolean;
  secretEncrypted: Buffer | null;
}

function mapTrigger(r: Record<string, unknown>): TriggerRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    id: r['id'] as string,
    workflowId: r['workflow_id'] as string,
    nodeId: r['node_id'] as string,
    type: r['type'] as 'webhook' | 'schedule',
    routeKey: r['route_key'] as string,
    authMode: (r['auth_mode'] as string | null) ?? null,
    idempotencyKeyPath: (r['idempotency_key_path'] as string | null) ?? null,
    cron: (r['cron'] as string | null) ?? null,
    timezone: (r['timezone'] as string | null) ?? null,
    nextFireAt: ts(r['next_fire_at']),
    active: r['active'] as boolean,
    secretEncrypted: (r['secret_encrypted'] as Buffer | null) ?? null,
  };
}

export async function upsertTrigger(
  db: Db,
  args: {
    workflowId: string;
    nodeId: string;
    type: 'webhook' | 'schedule';
    authMode?: string;
    idempotencyKeyPath?: string;
    cron?: string;
    timezone?: string;
    nextFireAt?: Date | null;
    secretEncrypted?: Buffer | null;
  },
): Promise<TriggerRow> {
  const routeKey = randomBytes(24).toString('base64url');
  const r = await db.query(
    `INSERT INTO workflow_triggers
       (workspace_id, workflow_id, node_id, type, route_key, auth_mode, secret_encrypted,
        idempotency_key_path, cron, timezone, next_fire_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (workflow_id, node_id) DO UPDATE SET
       type = EXCLUDED.type,
       auth_mode = EXCLUDED.auth_mode,
       secret_encrypted = COALESCE(workflow_triggers.secret_encrypted, EXCLUDED.secret_encrypted),
       idempotency_key_path = EXCLUDED.idempotency_key_path,
       cron = EXCLUDED.cron,
       timezone = EXCLUDED.timezone,
       next_fire_at = EXCLUDED.next_fire_at,
       updated_at = now()
     RETURNING *`,
    [
      DEFAULT_WORKSPACE_ID,
      args.workflowId,
      args.nodeId,
      args.type,
      routeKey,
      args.authMode ?? null,
      args.secretEncrypted ?? null,
      args.idempotencyKeyPath ?? null,
      args.cron ?? null,
      args.timezone ?? null,
      args.nextFireAt ?? null,
    ],
  );
  return mapTrigger(r.rows[0] as Record<string, unknown>);
}

export async function getTriggerByRouteKey(db: Db, routeKey: string): Promise<TriggerRow | null> {
  const r = await db.query(`SELECT * FROM workflow_triggers WHERE route_key = $1`, [routeKey]);
  return r.rowCount ? mapTrigger(r.rows[0] as Record<string, unknown>) : null;
}

export async function listTriggers(db: Db, workflowId: string): Promise<TriggerRow[]> {
  const r = await db.query(`SELECT * FROM workflow_triggers WHERE workflow_id = $1 ORDER BY node_id`, [workflowId]);
  return (r.rows as Record<string, unknown>[]).map(mapTrigger);
}

export async function setTriggersActive(db: Db, workflowId: string, active: boolean): Promise<void> {
  await db.query(`UPDATE workflow_triggers SET active = $1, updated_at = now() WHERE workflow_id = $2`, [
    active,
    workflowId,
  ]);
}

export async function setWorkflowActive(db: Db, workflowId: string, active: boolean): Promise<void> {
  await db.query(`UPDATE workflows SET active = $1, updated_at = now() WHERE id = $2`, [active, workflowId]);
}

export async function deleteTriggersNotIn(db: Db, workflowId: string, nodeIds: string[]): Promise<void> {
  await db.query(`DELETE FROM workflow_triggers WHERE workflow_id = $1 AND NOT (node_id = ANY($2))`, [
    workflowId,
    nodeIds,
  ]);
}

export async function dueScheduleTriggers(client: pg.PoolClient, limit: number): Promise<TriggerRow[]> {
  const r = await client.query(
    `SELECT * FROM workflow_triggers
     WHERE type = 'schedule' AND active AND next_fire_at <= now()
     ORDER BY next_fire_at
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit],
  );
  return (r.rows as Record<string, unknown>[]).map(mapTrigger);
}

export async function updateNextFireAt(db: Db, triggerId: string, nextFireAt: Date): Promise<void> {
  await db.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
    nextFireAt,
    triggerId,
  ]);
}

export async function recentTestTriggerPayloads(db: Db, workflowId: string, limit: number): Promise<unknown[]> {
  const r = await db.query(
    `SELECT t.payload_json FROM trigger_events t
     JOIN executions e ON e.trigger_event_id = t.id
     WHERE t.workflow_id = $1 AND e.mode = 'test'
     ORDER BY t.received_at DESC
     LIMIT $2`,
    [workflowId, limit],
  );
  return (r.rows as { payload_json: unknown }[]).map((row) => row.payload_json);
}
```

Add to `packages/db/src/index.ts`:

```ts
export { deriveTriggerKey, encryptSecret, decryptSecret } from './crypto.js';
export * from './repos/triggers.js';
```

Note: `getWorkflow`'s `WorkflowRow` gains nothing — the new `workflows.active` column is read via `setWorkflowActive`/direct query where needed; ALSO extend `WorkflowRow` mapping with `active: boolean` (`mapWorkflow` adds `active: Boolean(r['active'])`, interface adds `active: boolean`) so the gateway can gate on it. Update `packages/db/src/repos/workflows.ts` accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck`
Expected: PASS (existing suites unaffected; migration 0002 applies once).

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat: trigger table, AES-GCM secret crypto, triggers repository with SKIP LOCKED lease"
```

---

### Task 2: Cron math + trigger connector types

**Files:**
- Create: `packages/engine-core/src/cron.ts`, `packages/connectors/src/webhook/trigger.ts`, `packages/connectors/src/schedule/trigger.ts`
- Modify: `packages/engine-core/package.json` (+`"cron-parser": "^4.9.0"`), `packages/engine-core/src/index.ts`, `packages/connectors/package.json` (+`"cron-parser": "^4.9.0"`), `packages/connectors/src/registry.ts`, `packages/connectors/src/index.ts`
- Test: `packages/engine-core/test/cron.test.ts`, `packages/connectors/test/triggerNodes.test.ts`

**Interfaces:**
- Produces:
  - `nextFireAt(cron: string, timezone: string, from: Date): Date` (engine-core; throws on invalid cron)
  - Connector `webhook.trigger`: kind `trigger`, params `{ authMode: 'none'|'token'|'hmac'; idempotencyKeyPath?: string }`, passthrough runner, `outputPorts: ['main']`
  - Connector `schedule.trigger`: kind `trigger`, params `{ cron: string (refined via cron-parser); timezone?: string (refined via Intl.supportedValuesOf) }`, passthrough runner
  - Both registered in `createDefaultRegistry` (validation and worker pick them up automatically).

- [ ] **Step 1: Write failing tests**

`packages/engine-core/test/cron.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { nextFireAt } from '../src/index.js';

describe('nextFireAt', () => {
  test('5-field cron advances to the next minute boundary', () => {
    const from = new Date('2026-07-24T10:15:30Z');
    const next = nextFireAt('* * * * *', 'UTC', from);
    expect(next.toISOString()).toBe('2026-07-24T10:16:00.000Z');
  });

  test('6-field seconds cron advances by seconds', () => {
    const from = new Date('2026-07-24T10:15:30.100Z');
    const next = nextFireAt('*/2 * * * * *', 'UTC', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(2000);
  });

  test('timezone is respected (daily 09:00 Jakarta = 02:00 UTC)', () => {
    const from = new Date('2026-07-24T00:00:00Z');
    const next = nextFireAt('0 9 * * *', 'Asia/Jakarta', from);
    expect(next.toISOString()).toBe('2026-07-24T02:00:00.000Z');
  });

  test('invalid cron throws', () => {
    expect(() => nextFireAt('not a cron', 'UTC', new Date())).toThrow();
    expect(() => nextFireAt('99 * * * *', 'UTC', new Date())).toThrow();
  });
});
```

`packages/connectors/test/triggerNodes.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { createDefaultRegistry, type NodeRunContext } from '../src/index.js';

const registry = createDefaultRegistry();

function ctx(parameters: unknown, triggerBody: unknown): NodeRunContext {
  return {
    executionId: 'e',
    nodeId: 'n',
    attempt: 1,
    parameters,
    triggerBody,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('webhook.trigger', () => {
  const def = () => registry.get('webhook.trigger')!;

  test('is registered as a trigger with main port', () => {
    expect(def().kind).toBe('trigger');
    expect(def().outputPorts).toEqual(['main']);
  });

  test('params schema accepts auth modes and optional dot-path', () => {
    expect(def().paramsSchema.safeParse({ authMode: 'hmac' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ authMode: 'token', idempotencyKeyPath: 'event.id' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ authMode: 'basic' }).success).toBe(false);
    expect(def().paramsSchema.safeParse({}).success).toBe(false);
  });

  test('runner passes the stored trigger payload through', async () => {
    const payload = { body: { a: 1 }, headers: {}, query: {} };
    const r = await def().run(ctx({ authMode: 'none' }, payload));
    expect(r).toEqual({ output: payload });
  });
});

describe('schedule.trigger', () => {
  const def = () => registry.get('schedule.trigger')!;

  test('params schema validates cron and timezone', () => {
    expect(def().paramsSchema.safeParse({ cron: '*/5 * * * *' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ cron: '0 9 * * *', timezone: 'Asia/Jakarta' }).success).toBe(true);
    expect(def().paramsSchema.safeParse({ cron: 'garbage' }).success).toBe(false);
    expect(def().paramsSchema.safeParse({ cron: '* * * * *', timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  test('runner passes the scheduler payload through', async () => {
    const payload = { firedAt: 'x', scheduledFor: 'y' };
    const r = await def().run(ctx({ cron: '* * * * *' }, payload));
    expect(r).toEqual({ output: payload });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @xperiment/engine-core test && pnpm --filter @xperiment/connectors test`
Expected: FAIL — modules missing / types unregistered.

- [ ] **Step 3: Implement**

`packages/engine-core/src/cron.ts`:

```ts
import { parseExpression } from 'cron-parser';

export function nextFireAt(cron: string, timezone: string, from: Date): Date {
  const it = parseExpression(cron, { currentDate: from, tz: timezone });
  return it.next().toDate();
}
```

Add to `packages/engine-core/src/index.ts`: `export { nextFireAt } from './cron.js';`

`packages/connectors/src/webhook/trigger.ts`:

```ts
import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

const paramsSchema = z
  .object({
    authMode: z.enum(['none', 'token', 'hmac']),
    idempotencyKeyPath: z.string().min(1).optional(),
  })
  .strict();

export const webhookTrigger: ConnectorDefinition = {
  type: 'webhook.trigger',
  kind: 'trigger',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  paramsSchema,
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
```

`packages/connectors/src/schedule/trigger.ts`:

```ts
import { parseExpression } from 'cron-parser';
import { z } from 'zod';
import type { ConnectorDefinition } from '../types.js';

function isValidCron(cron: string): boolean {
  try {
    parseExpression(cron);
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(tz: string): boolean {
  return (Intl.supportedValuesOf('timeZone') as string[]).includes(tz);
}

const paramsSchema = z
  .object({
    cron: z.string().refine(isValidCron, 'invalid cron expression'),
    timezone: z.string().refine(isValidTimezone, 'invalid IANA timezone').optional(),
  })
  .strict();

export const scheduleTrigger: ConnectorDefinition = {
  type: 'schedule.trigger',
  kind: 'trigger',
  operationVersion: '0.1.0',
  defaultEffectClass: 'pure',
  outputPorts: ['main'],
  paramsSchema,
  async run(ctx) {
    return { output: ctx.triggerBody ?? null };
  },
};
```

In `packages/connectors/src/registry.ts`, add both to the defs array (imports from `./webhook/trigger.js`, `./schedule/trigger.js`); export both from `src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @xperiment/engine-core test && pnpm --filter @xperiment/connectors test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-core packages/connectors pnpm-lock.yaml
git commit -m "feat: cron next-fire math, webhook.trigger and schedule.trigger node types"
```

---

### Task 3: API — activation lifecycle and trigger endpoints

**Files:**
- Create: `apps/api/src/routes/triggers.ts`
- Modify: `apps/api/src/server.ts` (register routes)
- Test: `apps/api/test/triggers.test.ts`

**Interfaces:**
- Consumes: triggers repo + crypto (Task 1), `nextFireAt` (Task 2), existing workflow repos, `workflowIrSchema`.
- Produces routes:
  - `POST /v1/workflows/:id/activate` → 409 problem if no published version; upserts trigger rows from the active version's trigger nodes (webhook: generates secret when `authMode != 'none'` and none exists; schedule: `nextFireAt(cron, tz ?? 'Asia/Jakarta', now)`); prunes rows for removed nodes; sets triggers + workflow active. Response `{ active: true, triggers: [{ nodeId, type, url?, testUrl?, secret?, cron?, timezone?, nextFireAt? }] }` — `url = {GATEWAY_URL}/t/{routeKey}`, `testUrl = {GATEWAY_URL}/t/test/{routeKey}`, `secret` decrypted (null for authMode none / schedule).
  - `POST /v1/workflows/:id/deactivate` → sets flags false; `{ active: false }`.
  - `GET /v1/workflows/:id/triggers` → same trigger shape as activate (list; includes secrets — pre-auth, hardened in sub-project C).
  - `GET /v1/workflows/:id/triggers/:nodeId/samples` → `{ samples: unknown[] }` (last 5 test payloads; 404 if the node has no trigger row).
- `ServerDeps` gains `gatewayUrl: string` and `triggerKey: Buffer` (server.ts: default `process.env['GATEWAY_URL'] ?? 'http://localhost:3003'`, key = `deriveTriggerKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me')`) — both overridable via `buildServer` deps for tests.

- [ ] **Step 1: Write failing tests**

`apps/api/test/triggers.test.ts` (integration; standard pattern; fixture with a webhook workflow and a schedule workflow):

```ts
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;

function webhookIr(authMode = 'hmac') {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_hook', name: 'Hook' },
    entrypoints: ['hook'],
    nodes: [
      {
        id: 'hook',
        kind: 'trigger',
        type: 'webhook.trigger',
        operationVersion: '0.1.0',
        parameters: { authMode, idempotencyKeyPath: 'event.id' },
      },
      {
        id: 'echo',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { got: '{{ trigger.body.body.event.id }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
  };
}

function scheduleIr() {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_cron', name: 'Cron' },
    entrypoints: ['tick'],
    nodes: [
      {
        id: 'tick',
        kind: 'trigger',
        type: 'schedule.trigger',
        operationVersion: '0.1.0',
        parameters: { cron: '*/5 * * * *', timezone: 'UTC' },
      },
      {
        id: 'echo',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { at: '{{ trigger.body.scheduledFor }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'tick', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
  };
}

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({
    pool,
    registry: createDefaultRegistry({ allowPrivateIps: true }),
    gatewayUrl: 'http://gw.test',
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function publishedWorkflow(definition: unknown): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'X' } });
  const id = created.json<{ id: string }>().id;
  await app.inject({
    method: 'PUT',
    url: `/v1/workflows/${id}/draft`,
    headers: { 'if-match': '1' },
    payload: { definition },
  });
  const pub = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/publish` });
  expect(pub.statusCode).toBe(201);
  return id;
}

describe('activation', () => {
  test('activate requires a published version', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', payload: { name: 'D' } });
    const id = created.json<{ id: string }>().id;
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    expect(r.statusCode).toBe(409);
  });

  test('activate materializes a webhook trigger with urls and secret', async () => {
    const id = await publishedWorkflow(webhookIr());
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      active: boolean;
      triggers: { nodeId: string; type: string; url: string; testUrl: string; secret: string | null }[];
    }>();
    expect(body.active).toBe(true);
    expect(body.triggers).toHaveLength(1);
    const t = body.triggers[0]!;
    expect(t.nodeId).toBe('hook');
    expect(t.url).toMatch(/^http:\/\/gw\.test\/t\/[A-Za-z0-9_-]+$/);
    expect(t.testUrl).toContain('/t/test/');
    expect(t.secret).toBeTruthy(); // hmac mode -> generated secret returned
  });

  test('re-activate preserves the webhook URL; authMode none has no secret', async () => {
    const id = await publishedWorkflow(webhookIr());
    const first = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const url1 = first.json<{ triggers: { url: string }[] }>().triggers[0]!.url;
    await app.inject({ method: 'POST', url: `/v1/workflows/${id}/deactivate` });
    const second = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    expect(second.json<{ triggers: { url: string }[] }>().triggers[0]!.url).toBe(url1);

    const id2 = await publishedWorkflow(webhookIr('none'));
    const r2 = await app.inject({ method: 'POST', url: `/v1/workflows/${id2}/activate` });
    expect(r2.json<{ triggers: { secret: string | null }[] }>().triggers[0]!.secret).toBeNull();
  });

  test('activate computes nextFireAt for schedule triggers', async () => {
    const id = await publishedWorkflow(scheduleIr());
    const r = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const t = r.json<{ triggers: { type: string; nextFireAt: string | null; cron: string }[] }>().triggers[0]!;
    expect(t.type).toBe('schedule');
    expect(t.cron).toBe('*/5 * * * *');
    expect(new Date(t.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
  });

  test('deactivate flips flags; list shows triggers either way', async () => {
    const id = await publishedWorkflow(webhookIr());
    await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const off = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/deactivate` });
    expect(off.json<{ active: boolean }>().active).toBe(false);
    const list = await app.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers` });
    expect(list.json<{ triggers: unknown[] }>().triggers).toHaveLength(1);
  });

  test('samples endpoint returns recent test payloads (404 for unknown node)', async () => {
    const id = await publishedWorkflow(webhookIr());
    await app.inject({ method: 'POST', url: `/v1/workflows/${id}/activate` });
    const missing = await app.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers/ghost/samples` });
    expect(missing.statusCode).toBe(404);
    const empty = await app.inject({ method: 'GET', url: `/v1/workflows/${id}/triggers/hook/samples` });
    expect(empty.json<{ samples: unknown[] }>().samples).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @xperiment/api test`
Expected: FAIL — routes missing (404), `gatewayUrl` not a known dep.

- [ ] **Step 3: Implement**

Extend `apps/api/src/server.ts`:

```ts
import { deriveTriggerKey } from '@xperiment/db';
// ServerDeps gains:
export interface ServerDeps {
  pool: pg.Pool;
  registry: ConnectorRegistry;
  gatewayUrl?: string;
  triggerKey?: Buffer;
}
// inside buildServer, before route registration:
const resolvedDeps = {
  ...deps,
  gatewayUrl: deps.gatewayUrl ?? process.env['GATEWAY_URL'] ?? 'http://localhost:3003',
  triggerKey:
    deps.triggerKey ?? deriveTriggerKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
};
// pass resolvedDeps to registerTriggerRoutes(app, resolvedDeps) and keep others as-is
```

`apps/api/src/routes/triggers.ts`:

```ts
import { randomBytes } from 'node:crypto';
import {
  decryptSecret,
  deleteTriggersNotIn,
  encryptSecret,
  getDraft,
  getTriggerByRouteKey,
  getVersion,
  getWorkflow,
  listTriggers,
  recentTestTriggerPayloads,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
  type TriggerRow,
} from '@xperiment/db';
import { nextFireAt } from '@xperiment/engine-core';
import { workflowIrSchema, type IRNode } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import { sendProblem } from '../problem.js';
import type { ResolvedServerDeps } from './deps.js';

const DEFAULT_TZ = 'Asia/Jakarta';

function triggerView(t: TriggerRow, gatewayUrl: string, key: Buffer) {
  const base = { nodeId: t.nodeId, type: t.type, active: t.active };
  if (t.type === 'webhook') {
    return {
      ...base,
      url: `${gatewayUrl}/t/${t.routeKey}`,
      testUrl: `${gatewayUrl}/t/test/${t.routeKey}`,
      authMode: t.authMode,
      secret: t.secretEncrypted ? decryptSecret(t.secretEncrypted, key) : null,
    };
  }
  return { ...base, cron: t.cron, timezone: t.timezone, nextFireAt: t.nextFireAt };
}

export function registerTriggerRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.post('/v1/workflows/:id/activate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    if (!wf.activeVersionId) return sendProblem(reply, 409, 'No published version', 'Publish before activating');
    const version = await getVersion(deps.pool, wf.activeVersionId);
    if (!version) return sendProblem(reply, 409, 'Active version missing');
    const ir = workflowIrSchema.parse(version.definition);

    const triggerNodes = ir.nodes.filter(
      (n: IRNode) => n.type === 'webhook.trigger' || n.type === 'schedule.trigger',
    );
    const rows: TriggerRow[] = [];
    for (const node of triggerNodes) {
      if (node.type === 'webhook.trigger') {
        const p = node.parameters as { authMode: string; idempotencyKeyPath?: string };
        rows.push(
          await upsertTrigger(deps.pool, {
            workflowId: id,
            nodeId: node.id,
            type: 'webhook',
            authMode: p.authMode,
            ...(p.idempotencyKeyPath ? { idempotencyKeyPath: p.idempotencyKeyPath } : {}),
            secretEncrypted:
              p.authMode === 'none'
                ? null
                : encryptSecret(randomBytes(24).toString('base64url'), deps.triggerKey),
          }),
        );
      } else {
        const p = node.parameters as { cron: string; timezone?: string };
        const tz = p.timezone ?? DEFAULT_TZ;
        rows.push(
          await upsertTrigger(deps.pool, {
            workflowId: id,
            nodeId: node.id,
            type: 'schedule',
            cron: p.cron,
            timezone: tz,
            nextFireAt: nextFireAt(p.cron, tz, new Date()),
          }),
        );
      }
    }
    await deleteTriggersNotIn(deps.pool, id, ir.nodes.map((n) => n.id));
    await setTriggersActive(deps.pool, id, true);
    await setWorkflowActive(deps.pool, id, true);
    const fresh = await listTriggers(deps.pool, id);
    return { active: true, triggers: fresh.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerKey)) };
  });

  app.post('/v1/workflows/:id/deactivate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    await setTriggersActive(deps.pool, id, false);
    await setWorkflowActive(deps.pool, id, false);
    return { active: false };
  });

  app.get('/v1/workflows/:id/triggers', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = await getWorkflow(deps.pool, id);
    if (!wf) return sendProblem(reply, 404, 'Workflow not found');
    const rows = await listTriggers(deps.pool, id);
    return { triggers: rows.map((t) => triggerView(t, deps.gatewayUrl, deps.triggerKey)) };
  });

  app.get('/v1/workflows/:id/triggers/:nodeId/samples', async (req, reply) => {
    const { id, nodeId } = req.params as { id: string; nodeId: string };
    const rows = await listTriggers(deps.pool, id);
    if (!rows.some((t) => t.nodeId === nodeId)) return sendProblem(reply, 404, 'Trigger not found');
    return { samples: await recentTestTriggerPayloads(deps.pool, id, 5) };
  });
}
```

`apps/api/src/routes/deps.ts` gains the resolved type:

```ts
export type { ServerDeps } from '../server.js';
export interface ResolvedServerDeps {
  pool: import('pg').Pool;
  registry: import('@xperiment/connectors').ConnectorRegistry;
  gatewayUrl: string;
  triggerKey: Buffer;
}
```

(`registerWorkflowRoutes`/`registerExecutionRoutes` keep accepting the plain deps; only trigger routes need the resolved fields.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck`
Expected: PASS (all existing API tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: workflow activation lifecycle and trigger inspection endpoints"
```

---

### Task 4: Gateway service (`apps/gateway`, port 3003)

**Files:**
- Create: `apps/gateway/package.json`, `tsconfig.json`, `vitest.config.ts` (standard shapes; name `@xperiment/gateway`; dependencies `@xperiment/db`, `@xperiment/ir`, `@xperiment/queue`, `fastify ^5`, `pino ^9`; devDeps standard + pg/@types/pg/tsx; scripts dev/start/test/test:cov/typecheck)
- Create: `apps/gateway/src/verify.ts`, `src/server.ts`, `src/main.ts`
- Test: `apps/gateway/test/verify.test.ts`, `apps/gateway/test/gateway.test.ts`

**Interfaces:**
- Produces (verify.ts, all pure):
  - `verifyToken(authorizationHeader: string | undefined, secret: string): boolean` — expects `Bearer <secret>`, constant-time (compare sha256 digests via `timingSafeEqual`)
  - `verifyHmac(signatureHeader: string | undefined, secret: string, rawBody: Buffer): boolean` — expects `sha256=<hex>`, constant-time
  - `extractDedupKey(body: unknown, path: string | null): string | null` — dot-path into parsed body; non-string/number results → null
  - `sanitizeHeaders(headers: Record<string, unknown>): Record<string, string>` — lowercased, drops `authorization`, `cookie`, `x-xperiment-signature`
- Produces (server.ts): `buildGateway(deps: { pool: pg.Pool; triggerKey: Buffer }): FastifyInstance` with `POST /t/:routeKey`, `POST /t/test/:routeKey`, `GET /healthz`; JSON parsed from a raw-buffer content parser so HMAC sees exact bytes; `bodyLimit` 1 MB.
- Response contract: 202 `{ executionId, created: true }`; 200 `{ executionId, created: false }` on dedup; 401 problem on auth failure; 404 on unknown route key, inactive production trigger, or missing published version; 400 on unparseable JSON.

- [ ] **Step 1: Write failing unit tests**

`apps/gateway/test/verify.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { extractDedupKey, sanitizeHeaders, verifyHmac, verifyToken } from '../src/verify.js';

describe('verifyToken', () => {
  test('accepts exact bearer match only', () => {
    expect(verifyToken('Bearer sek', 'sek')).toBe(true);
    expect(verifyToken('Bearer nope', 'sek')).toBe(false);
    expect(verifyToken('sek', 'sek')).toBe(false); // missing scheme
    expect(verifyToken(undefined, 'sek')).toBe(false);
    expect(verifyToken('Bearer', 'sek')).toBe(false);
  });
});

describe('verifyHmac', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + createHmac('sha256', 'sek').update(body).digest('hex');

  test('accepts a correct signature over the raw body', () => {
    expect(verifyHmac(sig, 'sek', body)).toBe(true);
  });
  test('rejects wrong secret, altered body, bad format, missing header', () => {
    expect(verifyHmac(sig, 'other', body)).toBe(false);
    expect(verifyHmac(sig, 'sek', Buffer.from('{"a":2}'))).toBe(false);
    expect(verifyHmac('md5=abc', 'sek', body)).toBe(false);
    expect(verifyHmac('sha256=zz', 'sek', body)).toBe(false);
    expect(verifyHmac(undefined, 'sek', body)).toBe(false);
  });
});

describe('extractDedupKey', () => {
  test('resolves dot paths to strings and numbers', () => {
    expect(extractDedupKey({ event: { id: 'e-1' } }, 'event.id')).toBe('e-1');
    expect(extractDedupKey({ n: 7 }, 'n')).toBe('7');
    expect(extractDedupKey({ a: { b: null } }, 'a.b')).toBeNull();
    expect(extractDedupKey({ a: 1 }, 'missing.path')).toBeNull();
    expect(extractDedupKey({ obj: {} }, 'obj')).toBeNull(); // non-scalar
    expect(extractDedupKey({ a: 1 }, null)).toBeNull();
  });
});

describe('sanitizeHeaders', () => {
  test('drops sensitive headers, keeps the rest as strings', () => {
    const out = sanitizeHeaders({
      Authorization: 'Bearer x',
      Cookie: 'sid=1',
      'X-Xperiment-Signature': 'sha256=..',
      'Content-Type': 'application/json',
      'x-custom': 'keep',
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'x-custom': 'keep' });
  });
});
```

- [ ] **Step 2: Write failing integration tests**

`apps/gateway/test/gateway.test.ts` (integration; seeds workflow + version + trigger rows via repos; uses `app.inject` with raw payloads):

```ts
import { createHmac, randomBytes } from 'node:crypto';
import {
  createPool,
  createVersion,
  createWorkflow,
  deriveTriggerKey,
  encryptSecret,
  getExecutionDetail,
  runMigrations,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
} from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildGateway } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
const key = deriveTriggerKey('xperiment-dev-trigger-secret-change-me');

const hookIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_hook', name: 'Hook' },
  entrypoints: ['hook'],
  nodes: [
    { id: 'hook', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'hmac' } },
    {
      id: 'echo',
      kind: 'logic',
      type: 'core.transform',
      operationVersion: '0.1.0',
      parameters: { fields: { ok: true } },
    },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
};

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildGateway({ pool, triggerKey: key });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

async function seedHook(authMode: 'none' | 'token' | 'hmac', opts: { active?: boolean; idemPath?: string } = {}) {
  const wf = await createWorkflow(pool, { name: 'Hook' });
  await createVersion(pool, { workflowId: wf.id, definition: hookIr, hash: 'h' });
  const secret = randomBytes(12).toString('hex');
  const row = await upsertTrigger(pool, {
    workflowId: wf.id,
    nodeId: 'hook',
    type: 'webhook',
    authMode,
    ...(opts.idemPath ? { idempotencyKeyPath: opts.idemPath } : {}),
    secretEncrypted: authMode === 'none' ? null : encryptSecret(secret, key),
  });
  const active = opts.active ?? true;
  await setTriggersActive(pool, wf.id, active);
  await setWorkflowActive(pool, wf.id, active);
  return { workflowId: wf.id, routeKey: row.routeKey, secret };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

describe('gateway', () => {
  test('hmac-authenticated production webhook creates an execution (202)', async () => {
    const { routeKey, secret } = await seedHook('hmac');
    const body = JSON.stringify({ event: { id: 'ev-1' }, name: 'Budi' });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sign(secret, body) },
      payload: body,
    });
    expect(r.statusCode).toBe(202);
    const { executionId, created } = r.json<{ executionId: string; created: boolean }>();
    expect(created).toBe(true);
    const detail = await getExecutionDetail(pool, executionId);
    expect(detail?.execution.status).toBe('CREATED');
  });

  test('stored payload has sanitized headers and body/query shape', async () => {
    const { routeKey, secret } = await seedHook('hmac');
    const body = JSON.stringify({ a: 1 });
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}?src=crm`,
      headers: {
        'content-type': 'application/json',
        'x-xperiment-signature': sign(secret, body),
        authorization: 'Bearer should-vanish',
      },
      payload: body,
    });
    const { executionId } = r.json<{ executionId: string }>();
    const stored = await pool.query(
      `SELECT t.payload_json FROM trigger_events t JOIN executions e ON e.trigger_event_id = t.id WHERE e.id = $1`,
      [executionId],
    );
    const payload = (stored.rows[0] as { payload_json: { body: unknown; headers: Record<string, string>; query: Record<string, string> } }).payload_json;
    expect(payload.body).toEqual({ a: 1 });
    expect(payload.query).toEqual({ src: 'crm' });
    expect(payload.headers['authorization']).toBeUndefined();
    expect(payload.headers['x-xperiment-signature']).toBeUndefined();
  });

  test('bad signature and bad token are 401 with no execution', async () => {
    const { routeKey } = await seedHook('hmac');
    const r = await app.inject({
      method: 'POST',
      url: `/t/${routeKey}`,
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': 'sha256=deadbeef' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
    const tok = await seedHook('token');
    const r2 = await app.inject({
      method: 'POST',
      url: `/t/${tok.routeKey}`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      payload: '{}',
    });
    expect(r2.statusCode).toBe(401);
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(0);
  });

  test('duplicate via idempotencyKeyPath dedupes (200, same execution)', async () => {
    const { routeKey } = await seedHook('none', { idemPath: 'event.id' });
    const body = JSON.stringify({ event: { id: 'same' } });
    const first = await app.inject({ method: 'POST', url: `/t/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: body });
    const second = await app.inject({ method: 'POST', url: `/t/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: body });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ executionId: string }>().executionId).toBe(first.json<{ executionId: string }>().executionId);
  });

  test('identical raw body without key path dedupes via body hash', async () => {
    const { routeKey } = await seedHook('none');
    const body = JSON.stringify({ fixed: true });
    await app.inject({ method: 'POST', url: `/t/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: body });
    const second = await app.inject({ method: 'POST', url: `/t/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: body });
    expect(second.statusCode).toBe(200);
  });

  test('inactive trigger: production 404, test endpoint 202 with mode=test', async () => {
    const { routeKey } = await seedHook('none', { active: false });
    const prod = await app.inject({ method: 'POST', url: `/t/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: '{"x":1}' });
    expect(prod.statusCode).toBe(404);
    const testR = await app.inject({ method: 'POST', url: `/t/test/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: '{"x":1}' });
    expect(testR.statusCode).toBe(202);
    const { executionId } = testR.json<{ executionId: string }>();
    const mode = await pool.query(`SELECT mode FROM executions WHERE id = $1`, [executionId]);
    expect((mode.rows[0] as { mode: string }).mode).toBe('test');
  });

  test('unknown route key 404; malformed JSON 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/t/doesnotexist', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(404);
    const { routeKey } = await seedHook('none');
    const bad = await app.inject({ method: 'POST', url: `/t/${routeKey}`, headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm --filter @xperiment/gateway test`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement verify.ts, server.ts, main.ts**

`apps/gateway/src/verify.ts`:

```ts
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export function verifyToken(authorizationHeader: string | undefined, secret: string): boolean {
  if (!authorizationHeader) return false;
  const [scheme, token, ...rest] = authorizationHeader.split(' ');
  if (scheme !== 'Bearer' || !token || rest.length > 0) return false;
  return safeEqual(token, secret);
}

export function verifyHmac(signatureHeader: string | undefined, secret: string, rawBody: Buffer): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(signatureHeader.slice('sha256='.length), expected);
}

export function extractDedupKey(body: unknown, path: string | null): string | null {
  if (!path) return null;
  let cur: unknown = body;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === 'string' && cur.length > 0) return cur;
  if (typeof cur === 'number') return String(cur);
  return null;
}

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'x-xperiment-signature']);

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    if (typeof v === 'string') out[lower] = v;
  }
  return out;
}
```

`apps/gateway/src/server.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import {
  createExecutionWithTrigger,
  decryptSecret,
  getTriggerByRouteKey,
  getVersion,
  getWorkflow,
} from '@xperiment/db';
import { workflowIrSchema } from '@xperiment/ir';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { extractDedupKey, sanitizeHeaders, verifyHmac, verifyToken } from './verify.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;

export interface GatewayDeps {
  pool: pg.Pool;
  triggerKey: Buffer;
}

export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
  });
  // Keep raw bytes for HMAC; parse JSON manually.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, payload, done) => {
    done(null, payload);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  const handle = (mode: 'production' | 'test') => async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { routeKey } = req.params as { routeKey: string };
    const trigger = await getTriggerByRouteKey(deps.pool, routeKey);
    if (!trigger) return reply.status(404).send({ title: 'Not found', status: 404 });

    const wf = await getWorkflow(deps.pool, trigger.workflowId);
    if (!wf?.activeVersionId) return reply.status(404).send({ title: 'Not found', status: 404 });
    if (mode === 'production' && (!trigger.active || !wf.active)) {
      return reply.status(404).send({ title: 'Not found', status: 404 });
    }

    const rawBody = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    if (trigger.authMode === 'token' || trigger.authMode === 'hmac') {
      const secret = trigger.secretEncrypted ? decryptSecret(trigger.secretEncrypted, deps.triggerKey) : '';
      const ok =
        trigger.authMode === 'token'
          ? verifyToken(req.headers['authorization'], secret)
          : verifyHmac(req.headers['x-xperiment-signature'] as string | undefined, secret, rawBody);
      if (!ok) return reply.status(401).send({ title: 'Unauthorized', status: 401 });
    }

    let body: unknown = null;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return reply.status(400).send({ title: 'Invalid JSON body', status: 400 });
      }
    }

    const dedupKey =
      extractDedupKey(body, trigger.idempotencyKeyPath) ??
      (req.headers['idempotency-key'] as string | undefined) ??
      createHash('sha256').update(rawBody).digest('hex');

    const version = await getVersion(deps.pool, wf.activeVersionId);
    if (!version) return reply.status(404).send({ title: 'Not found', status: 404 });
    const ir = workflowIrSchema.parse(version.definition);

    const { execution, created } = await createExecutionWithTrigger(deps.pool, {
      workflowId: trigger.workflowId,
      versionId: version.id,
      idempotencyKey: `${mode === 'test' ? 'test:' : ''}${dedupKey}`,
      payload: {
        body,
        headers: sanitizeHeaders(req.headers as Record<string, unknown>),
        query: req.query ?? {},
      },
      nodeIds: ir.nodes.map((n) => n.id),
      executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    if (created && mode === 'test') {
      await deps.pool.query(`UPDATE executions SET mode = 'test' WHERE id = $1`, [execution.id]);
    }
    return reply.status(created ? 202 : 200).send({ executionId: execution.id, created });
  };

  app.post('/t/test/:routeKey', handle('test'));
  app.post('/t/:routeKey', handle('production'));
  return app;
}
```

`apps/gateway/src/main.ts` (standard service pattern — pool, migrations, `deriveTriggerKey` from env, `buildGateway`, outbox publisher via `createRedisConnection`/`createQueues`/`startOutboxPublisher`, listen on `GATEWAY_PORT` ?? 3003, SIGINT/SIGTERM shutdown — mirror `apps/api/src/main.ts` exactly, substituting `buildGateway`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @xperiment/gateway test && pnpm --filter @xperiment/gateway typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway pnpm-lock.yaml
git commit -m "feat: webhook gateway with fast-ack, hmac/token auth, dedup, test mode"
```

---

### Task 5: Scheduler service (`apps/scheduler`, port 3004)

**Files:**
- Create: `apps/scheduler/package.json`, `tsconfig.json`, `vitest.config.ts` (standard shapes; name `@xperiment/scheduler`; dependencies `@xperiment/db`, `@xperiment/engine-core`, `@xperiment/ir`, `@xperiment/queue`, `pino ^9`; devDeps standard + pg/@types/pg/tsx; scripts dev/start/test/test:cov/typecheck)
- Create: `apps/scheduler/src/tick.ts`, `src/main.ts`
- Test: `apps/scheduler/test/tick.test.ts`

**Interfaces:**
- Consumes: `dueScheduleTriggers`, `updateNextFireAt`, `createExecutionWithTrigger`, `withTx`, `getWorkflow`, `getVersion` (Task 1 / Phase 0), `nextFireAt` (Task 2).
- Produces: `runSchedulerTick(deps: { pool: pg.Pool; log: (msg, extra?) => void; graceMs?: number }): Promise<{ fired: number; skipped: number }>` — one lease transaction; per due trigger: misfire-skip if `now - nextFireAt > graceMs` (default 60000), else fire with idempotency key `sched:{triggerId}:{scheduledForISO}` and payload `{ firedAt, scheduledFor }`; always advance `next_fire_at` from `scheduledFor` (misfire: from now).
- `main.ts`: setInterval loop (`SCHEDULER_INTERVAL_MS` ?? 5000, reentrancy-guarded), outbox publisher, healthz on `SCHEDULER_PORT` ?? 3004, graceful shutdown.

- [ ] **Step 1: Write failing tests**

`apps/scheduler/test/tick.test.ts` (integration):

```ts
import {
  createPool,
  createVersion,
  createWorkflow,
  listTriggers,
  runMigrations,
  setTriggersActive,
  setWorkflowActive,
  upsertTrigger,
} from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runSchedulerTick } from '../src/tick.js';

let pool: Pool;
let workflowId: string;

const cronIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_cron', name: 'Cron' },
  entrypoints: ['tick'],
  nodes: [
    { id: 'tick', kind: 'trigger', type: 'schedule.trigger', operationVersion: '0.1.0', parameters: { cron: '* * * * * *' } },
    { id: 'echo', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0', parameters: { fields: { ok: true } } },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'tick', port: 'main' }, to: { nodeId: 'echo', port: 'input' } }],
};

const deps = () => ({ pool, log: () => {} });

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  const wf = await createWorkflow(pool, { name: 'Cron' });
  workflowId = wf.id;
  await createVersion(pool, { workflowId, definition: cronIr, hash: 'h' });
  await setWorkflowActive(pool, workflowId, true);
});

async function seedSchedule(nextFireAt: Date): Promise<string> {
  const row = await upsertTrigger(pool, {
    workflowId,
    nodeId: 'tick',
    type: 'schedule',
    cron: '* * * * * *', // every second (6-field)
    timezone: 'UTC',
    nextFireAt,
  });
  await setTriggersActive(pool, workflowId, true);
  return row.id;
}

describe('runSchedulerTick', () => {
  test('fires a due trigger once and advances next_fire_at', async () => {
    await seedSchedule(new Date(Date.now() - 500));
    const r1 = await runSchedulerTick(deps());
    expect(r1.fired).toBe(1);
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(1);
    const trig = (await listTriggers(pool, workflowId))[0]!;
    expect(new Date(trig.nextFireAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('re-running a tick for the same scheduledFor does not double-fire (idempotency)', async () => {
    const due = new Date(Date.now() - 500);
    await seedSchedule(due);
    await runSchedulerTick(deps());
    // Force the same scheduledFor back into the due set to simulate a crashed tick.
    await pool.query(`UPDATE workflow_triggers SET next_fire_at = $1 WHERE workflow_id = $2`, [due, workflowId]);
    const r2 = await runSchedulerTick(deps());
    expect(r2.fired).toBe(1); // it "fires" again but…
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(1); // …the idempotency key dedupes
  });

  test('misfire beyond grace is skipped forward without firing', async () => {
    await seedSchedule(new Date(Date.now() - 10 * 60_000)); // 10 minutes late
    const r = await runSchedulerTick({ ...deps(), graceMs: 60000 });
    expect(r).toEqual({ fired: 0, skipped: 1 });
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(0);
    const trig = (await listTriggers(pool, workflowId))[0]!;
    expect(new Date(trig.nextFireAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('inactive or future triggers are untouched', async () => {
    await seedSchedule(new Date(Date.now() + 3600_000));
    expect(await runSchedulerTick(deps())).toEqual({ fired: 0, skipped: 0 });
    await pool.query(`UPDATE workflow_triggers SET active = false, next_fire_at = now() - interval '1 second'`);
    expect(await runSchedulerTick(deps())).toEqual({ fired: 0, skipped: 0 });
  });

  test('two concurrent ticks fire exactly once total', async () => {
    await seedSchedule(new Date(Date.now() - 500));
    const [a, b] = await Promise.all([runSchedulerTick(deps()), runSchedulerTick(deps())]);
    expect(a.fired + b.fired).toBe(1); // SKIP LOCKED gives the row to one tick only
    const count = await pool.query(`SELECT count(*)::int AS c FROM executions`);
    expect((count.rows[0] as { c: number }).c).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm install && pnpm --filter @xperiment/scheduler test`
Expected: FAIL — `src/tick.js` missing.

- [ ] **Step 3: Implement tick and main**

`apps/scheduler/src/tick.ts`:

```ts
import {
  createExecutionWithTrigger,
  dueScheduleTriggers,
  getVersion,
  getWorkflow,
  withTx,
} from '@xperiment/db';
import { nextFireAt } from '@xperiment/engine-core';
import { workflowIrSchema } from '@xperiment/ir';
import type pg from 'pg';

const DEFAULT_GRACE_MS = 60000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 900000;
const BATCH = 20;

export interface SchedulerDeps {
  pool: pg.Pool;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  graceMs?: number;
}

export async function runSchedulerTick(deps: SchedulerDeps): Promise<{ fired: number; skipped: number }> {
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  let fired = 0;
  let skipped = 0;

  await withTx(deps.pool, async (client) => {
    const due = await dueScheduleTriggers(client, BATCH);
    const now = new Date();

    for (const trigger of due) {
      const scheduledFor = new Date(trigger.nextFireAt!);
      const tz = trigger.timezone ?? 'Asia/Jakarta';

      if (now.getTime() - scheduledFor.getTime() > graceMs) {
        skipped += 1;
        deps.log('schedule.misfire_skipped', { triggerId: trigger.id, scheduledFor: scheduledFor.toISOString() });
        await client.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
          nextFireAt(trigger.cron!, tz, now),
          trigger.id,
        ]);
        continue;
      }

      const wf = await getWorkflow(deps.pool, trigger.workflowId);
      if (!wf?.activeVersionId) continue;
      const version = await getVersion(deps.pool, wf.activeVersionId);
      if (!version) continue;
      const ir = workflowIrSchema.parse(version.definition);

      // Fires in its own transaction; if this lease tx later rolls back the
      // idempotency key makes the re-fire a no-op.
      await createExecutionWithTrigger(deps.pool, {
        workflowId: trigger.workflowId,
        versionId: version.id,
        idempotencyKey: `sched:${trigger.id}:${scheduledFor.toISOString()}`,
        payload: { firedAt: now.toISOString(), scheduledFor: scheduledFor.toISOString() },
        nodeIds: ir.nodes.map((n) => n.id),
        executionTimeoutMs: ir.metadata?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      });
      fired += 1;
      deps.log('schedule.fired', { triggerId: trigger.id, scheduledFor: scheduledFor.toISOString() });

      await client.query(`UPDATE workflow_triggers SET next_fire_at = $1, updated_at = now() WHERE id = $2`, [
        nextFireAt(trigger.cron!, tz, scheduledFor),
        trigger.id,
      ]);
    }
  });

  return { fired, skipped };
}
```

`apps/scheduler/src/main.ts` (standard service pattern: pool + migrations, pino, outbox publisher, healthz `node:http` server on `SCHEDULER_PORT` ?? 3004 — mirror `apps/orchestrator/src/main.ts` minus BullMQ workers, plus):

```ts
const intervalMs = Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 5000);
let running = false;
const timer = setInterval(() => {
  if (running) return;
  running = true;
  void runSchedulerTick({ pool, log: (msg, extra) => logger.info(extra ?? {}, msg) })
    .catch((e: unknown) => logger.error({ err: (e as Error).message }, 'scheduler tick failed'))
    .finally(() => {
      running = false;
    });
}, intervalMs);
// clearInterval(timer) inside shutdown()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @xperiment/scheduler test && pnpm --filter @xperiment/scheduler typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/scheduler pnpm-lock.yaml
git commit -m "feat: cron scheduler with SKIP LOCKED lease, misfire skip, idempotent firing"
```

---

### Task 6: E2E scenarios, env/docs, full verification

**Files:**
- Modify: `e2e/test/helpers.ts` (gateway/scheduler spawn + env), `.env.example`, `README.md`
- Create: `e2e/test/triggers.test.ts`

**Interfaces:**
- Consumes: everything. Gateway e2e port 3103, scheduler 3104; `SCHEDULER_INTERVAL_MS=500` in e2e env; API spawned with `GATEWAY_URL=http://127.0.0.1:3103`.

- [ ] **Step 1: Extend e2e helpers**

In `e2e/test/helpers.ts`:
- `SERVICE_PORTS` becomes `[3100, 3101, 3102, 3103, 3104]`.
- `SERVICE_ENV` gains: `GATEWAY_PORT: '3103'`, `SCHEDULER_PORT: '3104'`, `SCHEDULER_INTERVAL_MS: '500'`, `GATEWAY_URL: 'http://127.0.0.1:3103'`, `TRIGGER_SECRET_KEY: 'xperiment-e2e-trigger-secret'`.
- `spawnService` filter union gains `'@xperiment/gateway' | '@xperiment/scheduler'`.
- `waitForPortsFree` urls list gains `'http://127.0.0.1:3103/healthz'` and `'http://127.0.0.1:3104'`.

- [ ] **Step 2: Write the trigger e2e scenarios**

`e2e/test/triggers.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  api,
  API_URL,
  killPortOwners,
  killService,
  prepareDatabase,
  spawnService,
  waitForHealthz,
  waitForPortsFree,
  waitForTerminal,
} from './helpers.js';

const GATEWAY_URL = 'http://127.0.0.1:3103';

let pool: Pool;
let services: ChildProcess[] = [];

function webhookIr() {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_hook', name: 'Hook' },
    entrypoints: ['hook'],
    nodes: [
      {
        id: 'hook', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0',
        parameters: { authMode: 'hmac', idempotencyKeyPath: 'event.id' },
      },
      {
        id: 'shape', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0',
        parameters: { fields: { lead: '{{ trigger.body.body.name }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'shape', port: 'input' } }],
  };
}

function scheduleIr() {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_cron', name: 'Cron' },
    entrypoints: ['tick'],
    nodes: [
      {
        id: 'tick', kind: 'trigger', type: 'schedule.trigger', operationVersion: '0.1.0',
        parameters: { cron: '* * * * * *', timezone: 'UTC' },
      },
      {
        id: 'stamp', kind: 'logic', type: 'core.transform', operationVersion: '0.1.0',
        parameters: { fields: { at: '{{ trigger.body.scheduledFor }}' } },
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 'tick', port: 'main' }, to: { nodeId: 'stamp', port: 'input' } }],
  };
}

async function publishedAndActivated(definition: unknown): Promise<{ id: string; url: string; testUrl: string; secret: string | null }> {
  const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'trigger-e2e' });
  await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
  const pub = await api('POST', `/v1/workflows/${created.body.id}/publish`);
  if (pub.status !== 201) throw new Error(`publish failed: ${JSON.stringify(pub.body)}`);
  const act = await api<{ triggers: { url?: string; testUrl?: string; secret?: string | null }[] }>(
    'POST', `/v1/workflows/${created.body.id}/activate`,
  );
  const t = act.body.triggers[0]!;
  return { id: created.body.id, url: t.url ?? '', testUrl: t.testUrl ?? '', secret: t.secret ?? null };
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

async function hook(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: { executionId: string; created: boolean } }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: res.status, body: (await res.json()) as { executionId: string; created: boolean } };
}

beforeAll(async () => {
  pool = await prepareDatabase();
  await waitForPortsFree();
  services = [
    spawnService('@xperiment/api'),
    spawnService('@xperiment/orchestrator'),
    spawnService('@xperiment/worker'),
    spawnService('@xperiment/gateway'),
    spawnService('@xperiment/scheduler'),
  ];
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz('http://127.0.0.1:3101');
  await waitForHealthz('http://127.0.0.1:3102');
  await waitForHealthz(`${GATEWAY_URL}/healthz`);
  await waitForHealthz('http://127.0.0.1:3104');
}, 120000);

afterAll(async () => {
  for (const s of services) killService(s);
  await killPortOwners();
  await pool.end();
});

describe('trigger e2e', () => {
  test('signed production webhook drives a full execution', async () => {
    const wf = await publishedAndActivated(webhookIr());
    const body = JSON.stringify({ event: { id: 'lead-1' }, name: 'Budi' });
    const r = await hook(wf.url, body, { 'x-xperiment-signature': sign(wf.secret!, body) });
    expect(r.status).toBe(202);
    const detail = await waitForTerminal(r.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
  });

  test('bad signature is rejected with no execution', async () => {
    const wf = await publishedAndActivated(webhookIr());
    const r = await fetch(wf.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': 'sha256=bad' },
      body: '{"event":{"id":"x"}}',
    });
    expect(r.status).toBe(401);
  });

  test('duplicate delivery with same event id yields one execution', async () => {
    const wf = await publishedAndActivated(webhookIr());
    const body = JSON.stringify({ event: { id: 'dup-1' }, name: 'Sari' });
    const h = { 'x-xperiment-signature': sign(wf.secret!, body) };
    const first = await hook(wf.url, body, h);
    const second = await hook(wf.url, body, h);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.executionId).toBe(first.body.executionId);
  });

  test('deactivate stops production URL but test URL still works', async () => {
    const wf = await publishedAndActivated(webhookIr());
    await api('POST', `/v1/workflows/${wf.id}/deactivate`);
    const body = JSON.stringify({ event: { id: 'post-deactivate' } });
    const prod = await fetch(wf.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xperiment-signature': sign(wf.secret!, body) },
      body,
    });
    expect(prod.status).toBe(404);
    const testR = await hook(wf.testUrl, body, { 'x-xperiment-signature': sign(wf.secret!, body) });
    expect(testR.status).toBe(202);
    const detail = await waitForTerminal(testR.body.executionId);
    expect(detail.execution.status).toBe('SUCCEEDED');
  });

  test('seconds-cron schedule fires a real execution', async () => {
    const wf = await publishedAndActivated(scheduleIr());
    const deadline = Date.now() + 20000;
    let found: { items: { id: string }[] } | null = null;
    for (;;) {
      const list = await api<{ items: { id: string }[] }>('GET', `/v1/executions?workflowId=${wf.id}&limit=5`);
      if (list.body.items.length > 0) {
        found = list.body;
        break;
      }
      if (Date.now() > deadline) throw new Error('schedule never fired');
      await new Promise((r) => setTimeout(r, 500));
    }
    const detail = await waitForTerminal(found.items[0]!.id);
    expect(detail.execution.status).toBe('SUCCEEDED');
    await api('POST', `/v1/workflows/${wf.id}/deactivate`); // stop firing for the rest of the suite
  });
});
```

- [ ] **Step 3: Update .env.example and README**

`.env.example` additions:

```text
GATEWAY_PORT=3003
SCHEDULER_PORT=3004
SCHEDULER_INTERVAL_MS=5000
GATEWAY_URL=http://localhost:3003
TRIGGER_SECRET_KEY=xperiment-dev-trigger-secret-change-me
```

README: add gateway/scheduler to the services list and layout section; add a "Triggers" subsection: activate via `POST /v1/workflows/:id/activate`, webhook URL shapes, HMAC signature format, schedule cron notes.

- [ ] **Step 4: Run the full suites**

Run: `docker compose up -d && pnpm test && pnpm run test:cov && pnpm typecheck && pnpm --filter @xperiment/e2e test`
Expected: all green; every package ≥ 80% coverage.

- [ ] **Step 5: Commit**

```bash
git add e2e .env.example README.md
git commit -m "feat: trigger e2e scenarios, gateway/scheduler service wiring, docs"
```

---

## Final Verification (after all tasks)

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` + `pnpm run test:cov` green with thresholds
- [ ] `pnpm --filter @xperiment/e2e test` green (13 scenarios total incl. 5 trigger scenarios)
- [ ] Manual smoke: activate the example workflow with a `webhook.trigger` variant; curl a signed request; watch it via `pnpm xperiment execution get <id>`
