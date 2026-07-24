# Phase 1 Sub-project B: Vault + Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypted credential vault + four credentialed connectors (postgres.query, telegram.sendMessage, openai.chat, gemini.generate) with just-in-time worker decryption and the PRD §22 acceptance e2e.

**Architecture:** Extends the merged monorepo. Spec: `docs/superpowers/specs/2026-07-24-phase1-vault-connectors-design.md`. All Phase 0/A patterns and global constraints apply.

**Tech Stack:** Existing stack; `pg` becomes a runtime dep of `@xperiment/connectors` (postgres.query).

## Global Constraints

- All prior global constraints apply.
- `CREDENTIALS_SECRET_KEY` env (≥16 chars); AES key = `sha256(env)` via existing `deriveTriggerKey`. Dev default `xperiment-dev-credentials-secret-change-me`; e2e uses `xperiment-e2e-credentials-secret`.
- connector_key values (exact): `postgres`, `telegram`, `openai`, `gemini`. Node types (exact): `postgres.query`, `telegram.sendMessage`, `openai.chat`, `gemini.generate`; `operationVersion` `"0.1.0"`.
- Default baseUrls (exact): `https://api.telegram.org`, `https://api.openai.com`, `https://generativelanguage.googleapis.com`.
- Secret-hygiene rule: no thrown error message may contain any credential value; unit tests enforce with `expect(msg).not.toContain(secret)`.

## File Structure

```text
packages/db/src/migrations/0003_connections.sql
packages/db/src/repos/connections.ts
packages/connectors/src/payloads.ts            # CONNECTION_PAYLOAD_SCHEMAS
packages/connectors/src/postgres/query.ts
packages/connectors/src/telegram/sendMessage.ts
packages/connectors/src/openai/chat.ts
packages/connectors/src/gemini/generate.ts
apps/api/src/routes/connections.ts
e2e/test/acceptance.test.ts
```

---

### Task 1: DB — migration 0003 + connections repository

**Files:**
- Create: `packages/db/src/migrations/0003_connections.sql`, `src/repos/connections.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/connections.test.ts`

**Interfaces (Produces):**
- `interface ConnectionRow { id: string; connectorKey: string; name: string; status: string; createdAt: string }`
- `createConnection(db, { connectorKey, name, encryptedPayload: Buffer }): Promise<ConnectionRow>`
- `listConnections(db): Promise<ConnectionRow[]>`
- `getConnectionWithPayload(db, id): Promise<(ConnectionRow & { encryptedPayload: Buffer }) | null>`
- `deleteConnection(db, id): Promise<boolean>`
- `countPublishedRefs(db, connectionId): Promise<number>` — jsonb scan of `workflow_versions.definition_json->'nodes'` for `connectionRef`

- [ ] **Step 1: Failing test** — `packages/db/test/connections.test.ts` (standard integration pattern):

```ts
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, decryptSecret, deriveTriggerKey, encryptSecret, runMigrations } from '../src/index.js';
import {
  countPublishedRefs,
  createConnection,
  deleteConnection,
  getConnectionWithPayload,
  listConnections,
} from '../src/repos/connections.js';
import { createVersion, createWorkflow } from '../src/repos/workflows.js';

let pool: Pool;
const key = deriveTriggerKey('xperiment-dev-credentials-secret-change-me');

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE connections, workflow_triggers, executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

describe('connections repo', () => {
  test('stores encrypted payload at rest and round-trips via decrypt', async () => {
    const payload = JSON.stringify({ botToken: 'tok-123' });
    const row = await createConnection(pool, {
      connectorKey: 'telegram',
      name: 'Bot',
      encryptedPayload: encryptSecret(payload, key),
    });
    expect(row.connectorKey).toBe('telegram');
    const raw = await pool.query(`SELECT encrypted_payload FROM connections WHERE id = $1`, [row.id]);
    const stored = (raw.rows[0] as { encrypted_payload: Buffer }).encrypted_payload;
    expect(stored.toString('utf8')).not.toContain('tok-123'); // encrypted at rest
    const withPayload = await getConnectionWithPayload(pool, row.id);
    expect(decryptSecret(withPayload!.encryptedPayload, key)).toBe(payload);
  });

  test('list omits payloads; delete removes; missing lookups are null/false', async () => {
    const row = await createConnection(pool, {
      connectorKey: 'openai',
      name: 'AI',
      encryptedPayload: encryptSecret('{}', key),
    });
    const list = await listConnections(pool);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!)).not.toContain('encryptedPayload');
    expect(await deleteConnection(pool, row.id)).toBe(true);
    expect(await deleteConnection(pool, row.id)).toBe(false);
    expect(await getConnectionWithPayload(pool, row.id)).toBeNull();
  });

  test('countPublishedRefs finds connectionRef inside published versions', async () => {
    const conn = await createConnection(pool, {
      connectorKey: 'postgres',
      name: 'DB',
      encryptedPayload: encryptSecret('{}', key),
    });
    const wf = await createWorkflow(pool, { name: 'W' });
    await createVersion(pool, {
      workflowId: wf.id,
      definition: { nodes: [{ id: 'q', connectionRef: conn.id }] },
      hash: 'h',
    });
    expect(await countPublishedRefs(pool, conn.id)).toBe(1);
    expect(await countPublishedRefs(pool, '00000000-0000-0000-0000-0000000000ff')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to fail** — `pnpm --filter @xperiment/db test` → FAIL (module missing).
- [ ] **Step 3: Implement**

`packages/db/src/migrations/0003_connections.sql`:

```sql
CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  connector_key TEXT NOT NULL,
  name TEXT NOT NULL,
  encrypted_payload BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_connections_workspace ON connections (workspace_id, connector_key);
```

`packages/db/src/repos/connections.ts`:

```ts
import { DEFAULT_WORKSPACE_ID, type Db } from '../pool.js';

export interface ConnectionRow {
  id: string;
  connectorKey: string;
  name: string;
  status: string;
  createdAt: string;
}

function mapConnection(r: Record<string, unknown>): ConnectionRow {
  const ts = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string));
  return {
    id: r['id'] as string,
    connectorKey: r['connector_key'] as string,
    name: r['name'] as string,
    status: r['status'] as string,
    createdAt: ts(r['created_at']),
  };
}

export async function createConnection(
  db: Db,
  args: { connectorKey: string; name: string; encryptedPayload: Buffer },
): Promise<ConnectionRow> {
  const r = await db.query(
    `INSERT INTO connections (workspace_id, connector_key, name, encrypted_payload)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [DEFAULT_WORKSPACE_ID, args.connectorKey, args.name, args.encryptedPayload],
  );
  return mapConnection(r.rows[0] as Record<string, unknown>);
}

export async function listConnections(db: Db): Promise<ConnectionRow[]> {
  const r = await db.query(`SELECT id, connector_key, name, status, created_at FROM connections ORDER BY created_at`);
  return (r.rows as Record<string, unknown>[]).map(mapConnection);
}

export async function getConnectionWithPayload(
  db: Db,
  id: string,
): Promise<(ConnectionRow & { encryptedPayload: Buffer }) | null> {
  const r = await db.query(`SELECT * FROM connections WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return { ...mapConnection(row), encryptedPayload: row['encrypted_payload'] as Buffer };
}

export async function deleteConnection(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM connections WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function countPublishedRefs(db: Db, connectionId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS c FROM workflow_versions v
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(v.definition_json->'nodes') n
       WHERE n->>'connectionRef' = $1
     )`,
    [connectionId],
  );
  return (r.rows[0] as { c: number }).c;
}
```

Add to `packages/db/src/index.ts`: `export * from './repos/connections.js';`

- [ ] **Step 4: Run to pass + typecheck** — `pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add packages/db && git commit -m "feat: connections table and repository with encrypted payloads"`

---

### Task 2: Connectors — connection contract + payload schemas + postgres.query

**Files:**
- Modify: `packages/connectors/src/types.ts` (add `requiresConnection?`, `testConnection?`, `ctx.connection?`), `src/registry.ts`, `src/index.ts`, `packages/connectors/package.json` (+`"pg": "^8.12.0"`, devDep `@types/pg`)
- Create: `packages/connectors/src/payloads.ts`, `src/postgres/query.ts`
- Modify: `packages/ir/src/registryLike.ts` (`NodeTypeInfo.requiresConnection?: string`)
- Test: `packages/connectors/test/postgresQuery.test.ts`, `test/payloads.test.ts`

**Interfaces (Produces):**
- `types.ts`: `NodeRunContext.connection?: unknown`; `ConnectorDefinition.requiresConnection?: string`; `ConnectorDefinition.testConnection?(payload: unknown, signal: AbortSignal): Promise<void>`
- `payloads.ts`: `CONNECTION_PAYLOAD_SCHEMAS: Record<'postgres'|'telegram'|'openai'|'gemini', z.ZodTypeAny>` (shapes per spec §3, `.strict()`)
- `postgres.query` def: `requiresConnection: 'postgres'`, params `{ sql: z.string().min(1), params: z.array(z.unknown()).optional() }`, run connects a throwaway `pg.Client` with `connectionString` from `ctx.connection`, executes `client.query(sql, params)`, returns `{ output: { rows, rowCount } }`; connection errors → `NodeRunError('network_error', 'database connection failed', true)`; query errors → `NodeRunError('query_error', <pg message — safe: contains SQL not creds>, false)`; `testConnection` runs `SELECT 1`.

- [ ] **Step 1: Failing tests**

`packages/connectors/test/payloads.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../src/index.js';

describe('CONNECTION_PAYLOAD_SCHEMAS', () => {
  test('validates the four payload shapes strictly', () => {
    expect(CONNECTION_PAYLOAD_SCHEMAS.postgres.safeParse({ connectionString: 'postgres://x' }).success).toBe(true);
    expect(CONNECTION_PAYLOAD_SCHEMAS.postgres.safeParse({}).success).toBe(false);
    expect(CONNECTION_PAYLOAD_SCHEMAS.telegram.safeParse({ botToken: 't' }).success).toBe(true);
    expect(CONNECTION_PAYLOAD_SCHEMAS.telegram.safeParse({ botToken: 't', baseUrl: 'http://s' }).success).toBe(true);
    expect(CONNECTION_PAYLOAD_SCHEMAS.openai.safeParse({ apiKey: 'k', extra: 1 }).success).toBe(false);
    expect(CONNECTION_PAYLOAD_SCHEMAS.gemini.safeParse({ apiKey: 'k' }).success).toBe(true);
  });
});
```

`packages/connectors/test/postgresQuery.test.ts` (integration — dockerized PG):

```ts
import { describe, expect, test } from 'vitest';
import { createDefaultRegistry, type NodeRunContext } from '../src/index.js';

const registry = createDefaultRegistry();
const def = () => registry.get('postgres.query')!;
const CONN = { connectionString: process.env['DATABASE_URL'] ?? 'postgres://xperiment:xperiment@localhost:5432/xperiment' };

function ctx(parameters: unknown, connection: unknown = CONN): NodeRunContext {
  return {
    executionId: 'e',
    nodeId: 'q',
    attempt: 1,
    parameters,
    triggerBody: null,
    connection,
    signal: AbortSignal.timeout(10000),
    log: () => {},
  };
}

describe('postgres.query', () => {
  test('declares its connection requirement', () => {
    expect(def().requiresConnection).toBe('postgres');
  });

  test('runs a parameterized select', async () => {
    const r = await def().run(ctx({ sql: 'SELECT $1::int AS n, $2::text AS s', params: [7, 'ok'] }));
    expect(r.output).toEqual({ rows: [{ n: 7, s: 'ok' }], rowCount: 1 });
  });

  test('query errors are non-retryable query_error', async () => {
    const err = await def()
      .run(ctx({ sql: 'SELECT * FROM definitely_missing_table' }))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('query_error');
    expect((err as { retryable: boolean }).retryable).toBe(false);
  });

  test('unreachable database is retryable network_error without leaking the conn string', async () => {
    const secret = 'postgres://user:supersecretpw@127.0.0.1:1/db';
    const err = await def()
      .run(ctx({ sql: 'SELECT 1' }, { connectionString: secret }))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('network_error');
    expect((err as { retryable: boolean }).retryable).toBe(true);
    expect((err as Error).message).not.toContain('supersecretpw');
  });

  test('testConnection succeeds against the real db and fails against a bad one', async () => {
    await expect(def().testConnection!(CONN, AbortSignal.timeout(10000))).resolves.toBeUndefined();
    await expect(
      def().testConnection!({ connectionString: 'postgres://x:y@127.0.0.1:1/db' }, AbortSignal.timeout(5000)),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement**

`packages/connectors/src/types.ts` — add to `NodeRunContext`: `connection?: unknown;` and to `ConnectorDefinition`: `requiresConnection?: string; testConnection?(payload: unknown, signal: AbortSignal): Promise<void>;`. Add `requiresConnection?: string;` to `NodeTypeInfo` in `packages/ir/src/registryLike.ts`.

`packages/connectors/src/payloads.ts`:

```ts
import { z } from 'zod';

export const CONNECTION_PAYLOAD_SCHEMAS = {
  postgres: z.object({ connectionString: z.string().min(1) }).strict(),
  telegram: z.object({ botToken: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  openai: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  gemini: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
} as const;

export type ConnectorKey = keyof typeof CONNECTION_PAYLOAD_SCHEMAS;
```

`packages/connectors/src/postgres/query.ts`:

```ts
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
```

Register in `registry.ts` defs array; export `postgresQuery` and `CONNECTION_PAYLOAD_SCHEMAS`, `type ConnectorKey` from `src/index.ts`. Add `"pg": "^8.12.0"` to connectors dependencies and `"@types/pg": "^8.11.0"` to devDependencies.

- [ ] **Step 4: Run to pass + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "feat: connection contract, payload schemas, postgres.query connector"`

---

### Task 3: Connectors — telegram, openai, gemini (stub-tested)

**Files:**
- Create: `packages/connectors/src/telegram/sendMessage.ts`, `src/openai/chat.ts`, `src/gemini/generate.ts`
- Modify: `packages/connectors/src/registry.ts`, `src/index.ts`
- Test: `packages/connectors/test/httpConnectors.test.ts`

**Interfaces (Produces):** connector defs per spec §5 with `requiresConnection` `'telegram'|'openai'|'gemini'`; all accept `baseUrl` in the connection payload. Request/response contracts:
- telegram: `POST {base}/bot{token}/sendMessage` body `{ chat_id, text }` → `{ ok: true, result: { message_id } }`; output `{ messageId }`.
- openai: `POST {base}/v1/chat/completions` header `Authorization: Bearer {apiKey}` body `{ model, messages: [ {role:'system'|'user', content} ] }` → output `{ text: choices[0].message.content }`.
- gemini: `POST {base}/v1beta/models/{model}:generateContent?key={apiKey}` body `{ contents: [{ parts: [{ text }] }] }` → output `{ text: candidates[0].content.parts[0].text }`.
- Non-2xx → `NodeRunError('http_error', 'provider returned <status>', false, { httpStatus })` (worker classifier applies policy); abort → timeout error as in http.request; secrets never in messages. `testConnection`: telegram `GET /bot{token}/getMe` (expect `ok:true`), openai `GET /v1/models`, gemini `GET /v1beta/models?key=...` — non-2xx throws generic `Error('connection test failed (<status>)')`.

- [ ] **Step 1: Failing tests** — `packages/connectors/test/httpConnectors.test.ts`: local `node:http` stub captures path/headers/body and returns scripted JSON per provider path; cases: happy output mapping for all three; auth header/token placement (telegram token in path, openai bearer header, gemini query key); 500 → `http_error` details.httpStatus 500; secret hygiene (`err.message` does not contain token/key); `testConnection` ok + failing (404) paths.

```ts
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDefaultRegistry, type NodeRunContext } from '../src/index.js';

let server: Server;
let base: string;
let lastReq: { path: string; auth: string | undefined; body: unknown } | null = null;
let failNext: number | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      lastReq = { path: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
      res.setHeader('content-type', 'application/json');
      if (failNext) {
        res.statusCode = failNext;
        failNext = null;
        res.end('{"error":"provider says no"}');
        return;
      }
      if (req.url!.includes('/sendMessage')) res.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
      else if (req.url!.includes('/chat/completions'))
        res.end(JSON.stringify({ choices: [{ message: { content: 'ai says hi' } }] }));
      else if (req.url!.includes(':generateContent'))
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini says hi' }] } }] }));
      else res.end(JSON.stringify({ ok: true, data: [] })); // getMe / models lists
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const registry = createDefaultRegistry();
const ctx = (type: string, parameters: unknown, connection: unknown): NodeRunContext => ({
  executionId: 'e',
  nodeId: 'n',
  attempt: 1,
  parameters,
  triggerBody: null,
  connection,
  signal: AbortSignal.timeout(5000),
  log: () => {},
});

describe('telegram.sendMessage', () => {
  const conn = () => ({ botToken: 'SECRET-BOT-TOKEN', baseUrl: base });
  test('sends and maps message id; token stays in path not headers', async () => {
    const r = await registry.get('telegram.sendMessage')!.run(ctx('t', { chatId: '99', text: 'halo' }, conn()));
    expect(r.output).toEqual({ messageId: 42 });
    expect(lastReq?.path).toContain('/botSECRET-BOT-TOKEN/sendMessage');
    expect(lastReq?.body).toEqual({ chat_id: '99', text: 'halo' });
  });
  test('provider 500 -> http_error with status, no secret in message', async () => {
    failNext = 500;
    const err = await registry
      .get('telegram.sendMessage')!
      .run(ctx('t', { chatId: '1', text: 'x' }, conn()))
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('http_error');
    expect(((err as { details: { httpStatus: number } }).details).httpStatus).toBe(500);
    expect((err as Error).message).not.toContain('SECRET-BOT-TOKEN');
  });
  test('testConnection ok and failing', async () => {
    await expect(registry.get('telegram.sendMessage')!.testConnection!(conn(), AbortSignal.timeout(3000))).resolves.toBeUndefined();
    failNext = 401;
    await expect(registry.get('telegram.sendMessage')!.testConnection!(conn(), AbortSignal.timeout(3000))).rejects.toThrow();
  });
});

describe('openai.chat', () => {
  const conn = () => ({ apiKey: 'SECRET-OPENAI-KEY', baseUrl: base });
  test('sends bearer auth, maps text, defaults model', async () => {
    const r = await registry.get('openai.chat')!.run(ctx('o', { prompt: 'hi', system: 'be nice' }, conn()));
    expect(r.output).toEqual({ text: 'ai says hi' });
    expect(lastReq?.auth).toBe('Bearer SECRET-OPENAI-KEY');
    expect((lastReq?.body as { model: string }).model).toBe('gpt-4o-mini');
    expect((lastReq?.body as { messages: { role: string }[] }).messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
  test('429 -> http_error retryable-by-policy fact, no key in message', async () => {
    failNext = 429;
    const err = await registry.get('openai.chat')!.run(ctx('o', { prompt: 'x' }, conn())).catch((e: unknown) => e);
    expect(((err as { details: { httpStatus: number } }).details).httpStatus).toBe(429);
    expect((err as Error).message).not.toContain('SECRET-OPENAI-KEY');
  });
});

describe('gemini.generate', () => {
  const conn = () => ({ apiKey: 'SECRET-GEMINI-KEY', baseUrl: base });
  test('key in query, maps text, defaults model', async () => {
    const r = await registry.get('gemini.generate')!.run(ctx('g', { prompt: 'hi' }, conn()));
    expect(r.output).toEqual({ text: 'gemini says hi' });
    expect(lastReq?.path).toContain('models/gemini-1.5-flash:generateContent');
    expect(lastReq?.path).toContain('key=SECRET-GEMINI-KEY');
  });
  test('500 -> http_error, no key in message', async () => {
    failNext = 500;
    const err = await registry.get('gemini.generate')!.run(ctx('g', { prompt: 'x' }, conn())).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('http_error');
    expect((err as Error).message).not.toContain('SECRET-GEMINI-KEY');
  });
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** the three connectors. Shared shape (shown for telegram; openai/gemini analogous with their contracts):

```ts
// packages/connectors/src/telegram/sendMessage.ts
import { z } from 'zod';
import { CONNECTION_PAYLOAD_SCHEMAS } from '../payloads.js';
import { NodeRunError, type ConnectorDefinition } from '../types.js';

const paramsSchema = z.object({ chatId: z.string().min(1), text: z.string().min(1) }).strict();
const DEFAULT_BASE = 'https://api.telegram.org';

function connOf(payload: unknown): { botToken: string; baseUrl?: string } {
  const parsed = CONNECTION_PAYLOAD_SCHEMAS.telegram.safeParse(payload);
  if (!parsed.success) throw new NodeRunError('connection_invalid', 'invalid telegram connection payload', false);
  return parsed.data;
}

async function post(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new NodeRunError('timeout', 'provider request timed out', false, { timeout: true });
    }
    throw new NodeRunError('network_error', 'provider request failed', true);
  }
  if (!res.ok) throw new NodeRunError('http_error', `provider returned ${res.status}`, false, { httpStatus: res.status });
  return res.json();
}

export const telegramSendMessage: ConnectorDefinition = {
  type: 'telegram.sendMessage',
  kind: 'action',
  operationVersion: '0.1.0',
  defaultEffectClass: 'write',
  outputPorts: ['main'],
  paramsSchema,
  requiresConnection: 'telegram',
  async run(ctx) {
    const parsed = paramsSchema.safeParse(ctx.parameters);
    if (!parsed.success) throw new NodeRunError('invalid_parameters', parsed.error.message, false);
    const conn = connOf(ctx.connection);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const data = (await post(
      `${base}/bot${conn.botToken}/sendMessage`,
      { chat_id: parsed.data.chatId, text: parsed.data.text },
      ctx.signal,
    )) as { ok: boolean; result?: { message_id: number } };
    if (!data.ok || !data.result) throw new NodeRunError('provider_error', 'telegram rejected the message', false);
    return { output: { messageId: data.result.message_id } };
  },
  async testConnection(payload, signal) {
    const conn = connOf(payload);
    const base = conn.baseUrl ?? DEFAULT_BASE;
    const res = await fetch(`${base}/bot${conn.botToken}/getMe`, { signal });
    if (!res.ok) throw new Error(`connection test failed (${res.status})`);
  },
};
```

openai/chat.ts: params `{ prompt: z.string().min(1), model: z.string().min(1).default('gpt-4o-mini'), system: z.string().optional() }` (use `.strict()`); bearer header; messages array builds `[{role:'system',content:system}]` only when system present, then `{role:'user',content:prompt}`; output text from `choices[0].message.content` (missing → `provider_error`). gemini/generate.ts: params `{ prompt: z.string().min(1), model: z.string().min(1).default('gemini-1.5-flash') }`; URL `${base}/v1beta/models/${model}:generateContent?key=${apiKey}`; body `{ contents: [{ parts: [{ text: prompt }] }] }`; output from `candidates[0].content.parts[0].text` (missing → `provider_error`); testConnection `GET ${base}/v1beta/models?key=${apiKey}`. Register all three in `registry.ts` and export from `index.ts`.

- [ ] **Step 4: Run to pass + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "feat: telegram, openai, gemini connectors with secret hygiene"`

---

### Task 4: IR — connectionRef + validation layer 5

**Files:**
- Modify: `packages/ir/src/types.ts`, `src/schema.ts` (`connectionRef: z.string().uuid().optional()` on nodes), `src/validate.ts` (layer 5), `src/registryLike.ts` (done in Task 2 — verify)
- Test: `packages/ir/test/connections.test.ts`

**Interfaces (Produces):** `validateWorkflow(raw, { registry, connections? })` where `connections?: { id: string; connectorKey: string }[]`; findings layer `'connections'`, codes `connection_required` | `connection_not_found` | `connection_wrong_type`. Layer runs only when `connections` is provided AND the node's registry entry has `requiresConnection`.

- [ ] **Step 1: Failing test** — `packages/ir/test/connections.test.ts`: fake registry entry `db.read` with `requiresConnection: 'postgres'`; four cases (missing ref, unknown ref, wrong-type ref, valid ref) plus "layer skipped when connections not passed" and "node without requiresConnection ignores connectionRef".

```ts
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { validateWorkflow, type RegistryLike } from '../src/index.js';

const registry: RegistryLike = {
  get(type: string) {
    if (type === 'manual.trigger')
      return { kind: 'trigger', paramsSchema: z.object({}).strict(), defaultEffectClass: 'pure', outputPorts: ['main'] };
    if (type === 'db.read')
      return {
        kind: 'action',
        paramsSchema: z.object({}).strict(),
        defaultEffectClass: 'read',
        outputPorts: ['main'],
        requiresConnection: 'postgres',
      };
    return undefined;
  },
};

const CONN = '11111111-1111-1111-1111-111111111111';

function ir(connectionRef?: string) {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'w', name: 'w' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'q',
        kind: 'action',
        type: 'db.read',
        operationVersion: '0.1.0',
        parameters: {},
        ...(connectionRef ? { connectionRef } : {}),
      },
    ],
    edges: [{ id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'q', port: 'input' } }],
  };
}

describe('connection validation layer', () => {
  const connections = [{ id: CONN, connectorKey: 'postgres' }];

  test('missing connectionRef on a requiring node', () => {
    const r = validateWorkflow(ir(), { registry, connections });
    expect(r.findings.some((f) => f.layer === 'connections' && f.code === 'connection_required' && f.nodeId === 'q')).toBe(true);
  });

  test('unknown and wrong-type refs', () => {
    const unknown = validateWorkflow(ir('22222222-2222-2222-2222-222222222222'), { registry, connections });
    expect(unknown.findings.some((f) => f.code === 'connection_not_found')).toBe(true);
    const wrong = validateWorkflow(ir(CONN), { registry, connections: [{ id: CONN, connectorKey: 'telegram' }] });
    expect(wrong.findings.some((f) => f.code === 'connection_wrong_type')).toBe(true);
  });

  test('valid ref passes; layer skipped without connections opt', () => {
    expect(validateWorkflow(ir(CONN), { registry, connections }).valid).toBe(true);
    expect(validateWorkflow(ir(), { registry }).valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — `IRNode.connectionRef?: string`; node zod gains `connectionRef: z.string().uuid().optional()`; in `validate.ts` after layer 4:

```ts
if (opts.connections) {
  const byId = new Map(opts.connections.map((c) => [c.id, c.connectorKey]));
  for (const node of ir.nodes) {
    const info = opts.registry.get(node.type);
    if (!info?.requiresConnection) continue;
    if (!node.connectionRef) {
      findings.push({ layer: 'connections', code: 'connection_required', message: `Node requires a '${info.requiresConnection}' connection`, nodeId: node.id });
    } else if (!byId.has(node.connectionRef)) {
      findings.push({ layer: 'connections', code: 'connection_not_found', message: 'Referenced connection does not exist', nodeId: node.id });
    } else if (byId.get(node.connectionRef) !== info.requiresConnection) {
      findings.push({ layer: 'connections', code: 'connection_wrong_type', message: `Connection must be '${info.requiresConnection}'`, nodeId: node.id });
    }
  }
}
```

with `ValidationFinding.layer` union extended to include `'connections'` and `validateWorkflow` opts type extended.

- [ ] **Step 4: Run to pass + typecheck (fix any api compile fallout from the widened opts).**
- [ ] **Step 5: Commit** — `git commit -m "feat: connectionRef in IR with connection validation layer"`

---

### Task 5: API — connections routes + validate/publish wiring

**Files:**
- Create: `apps/api/src/routes/connections.ts`
- Modify: `apps/api/src/server.ts` (register; `ResolvedServerDeps` gains `credentialsKey: Buffer` derived from `CREDENTIALS_SECRET_KEY`), `apps/api/src/routes/deps.ts`, `apps/api/src/routes/workflows.ts` (validate/publish pass `connections`)
- Test: `apps/api/test/connections.test.ts`

**Interfaces (Produces):** routes per spec §7; create validates payload with `CONNECTION_PAYLOAD_SCHEMAS[connectorKey]` (unknown key → 400); test route decrypts and calls the connector `testConnection` found via `registry.list().find(d => d.requiresConnection === connectorKey && d.testConnection)`, 10 s `AbortSignal.timeout`, failure → `{ ok: false, error: 'connection test failed' }` (never provider/raw error text); delete → 409 problem when `countPublishedRefs > 0`.

- [ ] **Step 1: Failing tests** — `apps/api/test/connections.test.ts`: create telegram connection (stub baseUrl) → 201 without payload echo and DB row encrypted; create with bad payload/unknown key → 400; list omits secrets; test route ok (stub 200) and failing (stub 401) with generic error; delete ok → 204; delete referenced by published version → 409; publish blocks a workflow whose postgres node lacks connectionRef (finding `connection_required`) and succeeds once set.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** routes + wiring; workflows validate/publish load `listConnections(pool)` and map to `{ id, connectorKey }` for `validateWorkflow`.
- [ ] **Step 4: Run to pass + typecheck; all existing api tests stay green.**
- [ ] **Step 5: Commit** — `git commit -m "feat: connections API with encrypted storage, test-connection, publish gating"`

---

### Task 6: Worker — connection resolution

**Files:**
- Modify: `apps/worker/src/runTask.ts` (resolve connection before executeNode), `apps/worker/src/main.ts` (derive credentials key from env)
- Test: `apps/worker/test/connections.test.ts`

**Interfaces (Produces):** `WorkerDeps` gains `credentialsKey: Buffer`. In `runNodeTask`, after the RUNNING claim and before `executeNode`: if `registry.get(node.type)?.requiresConnection` — missing `node.connectionRef` → fail `connection_required`; `getConnectionWithPayload` null or `connectorKey` mismatch → `connection_not_found`; `decryptSecret` throw → `connection_invalid`; else `connection = JSON.parse(decrypted)` passed into the run context. All three failures follow the existing non-retryable failure path (RETRY never applies). The decrypted payload is NOT included in `input_json` (only resolvedParams are, unchanged).

- [ ] **Step 1: Failing tests** — seed a workflow whose node is `postgres.query` with/without valid connectionRef; assert: happy path SUCCEEDED querying real PG; missing ref → FAILED `connection_required`; bogus ref → `connection_not_found`; tampered ciphertext → `connection_invalid`; `input_json` of the succeeded node does not contain the connection string.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass + typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "feat: worker just-in-time connection decryption with non-retryable failure modes"`

---

### Task 7: E2E acceptance scenario + env/docs + verification

**Files:**
- Create: `e2e/test/acceptance.test.ts`
- Modify: `e2e/test/helpers.ts` (`CREDENTIALS_SECRET_KEY: 'xperiment-e2e-credentials-secret'` in SERVICE_ENV), `.env.example`, `README.md`

**Scenario (PRD §22 skeleton):** stub server plays both OpenAI and Telegram. Create a `leads` table in the dockerized PG; create postgres/openai/telegram connections via the API (postgres → real compose DB; others → stub baseUrl); build workflow: `webhook.trigger` (hmac) → `postgres.query` (SELECT lead by phone from webhook body) → `core.if` (lead missing) → true: `openai.chat` (classify) → `telegram.sendMessage` (notify with `{{ nodes.classify.output.text }}`); publish (must pass connection validation), activate, send signed webhook, `waitForTerminal` → SUCCEEDED; assert the stub captured a Telegram message containing the AI stub text and webhook name; duplicate webhook → same execution. Then `.env.example` gains `CREDENTIALS_SECRET_KEY=xperiment-dev-credentials-secret-change-me`; README gains a Connections section (create → test → reference via `connectionRef`). Final verification: `pnpm test`, `pnpm run test:cov`, `pnpm typecheck`, `pnpm --filter @xperiment/e2e test` all green.

- [ ] **Steps: write test → run (services spawn) → fix → docs → full suites → commit** — `git commit -m "feat: PRD acceptance e2e with vault-backed connectors, docs"`

---

## Final Verification

- [ ] `pnpm typecheck` clean; `pnpm test` + `pnpm run test:cov` green ≥80%; e2e green (all files)
- [ ] Manual grep: no credential value appears in any `execution_events.payload_json` or `execution_nodes.input_json` produced by the e2e run
