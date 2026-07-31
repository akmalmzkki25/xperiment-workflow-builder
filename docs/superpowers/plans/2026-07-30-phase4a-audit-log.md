# Phase 4A — Workspace Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every privilege change in the audit spine Phase 3P shipped, and give admins a page to read it.

**Architecture:** Three repository functions own their own transaction (they hold `pg_advisory_xact_lock`, which releases at commit) so they take an actor and emit the audit row themselves; the other six sites emit from a route-level `withTx`. The read path resolves actor ids to an email or api-key name with two `LEFT JOIN`s rather than denormalising on write.

**Tech Stack:** TypeScript (ESM, run directly by tsx), Postgres 16 via `pg`, Fastify 5, Next.js 15 + TanStack Query, Vitest 2 with v8 coverage, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-30-phase4a-audit-log-design.md` (commit `81b373e`).

## Global Constraints

- Coverage thresholds are 80% on lines, statements, functions **and** branches, per package.
- **Run the full suite with `pnpm test`, never `pnpm -r test`.** The root script pins `--workspace-concurrency=1`; run concurrently, `@xperiment/queue`'s outbox publisher races other suites over `task_outbox` and 2 tests fail. Same for `pnpm test:cov`.
- Conventional commits: `<type>: <description>`. **No attribution trailer.**
- TypeScript is strict with `noUncheckedIndexedAccess` — indexed reads need `!` or a guard.
- **No token, key or `*_hash` may reach `metadata`.** `AuditMetadata` is scalars-only, which blocks an object spread but would still accept a token string. This is a review point, not a type guarantee.
- Audit rows describing a mutation are emitted on that mutation's transaction client. Rows describing no mutation may use the pool.
- `audit_events.id` is `BIGSERIAL`; node-postgres returns `int8` as a **string**. Cursors are strings.
- No `console.log` in application code.
- Docker `postgres` and `redis` must be up. They run under a compose project name that does not match the repo, so `docker compose ps` here prints nothing — check `docker ps`.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `apps/web/src/app/(app)/audit/page.tsx` | The audit log page |
| `apps/api/test/auditEmission.test.ts` | Emission tests for all nine actions |

**Modify**

| Path | Change |
|---|---|
| `packages/db/src/repos/audit.ts` | `AuditActor`; `AuditEventInput extends AuditActor`; `listAuditEvents` resolves actors |
| `packages/db/src/repos/auth.ts` | `updateMemberRole`, `acceptInvite`, `createWorkspaceWithOwner`, `createInvite` |
| `packages/db/src/index.ts` | export `AuditActor` |
| `apps/api/src/auth/plugin.ts` | annotate `auditActor` with `AuditActor` |
| `apps/api/src/routes/workspaces.ts` | five sites |
| `apps/api/src/routes/plan.ts` | `plan.change` |
| `apps/api/src/routes/invoices.ts` | `invoice.pay`, `invoice.mark_paid` |
| `apps/web/src/lib/api.ts` | `listAudit` + `AuditEvent` |
| `apps/web/src/components/shell/Sidebar.tsx` | nav entry |
| `packages/db/test/auth.test.ts`, `apps/api/test/*.test.ts` | callers of the widened returns |

**Ordering.** Task 1 establishes `AuditActor` and everything downstream consumes it. Tasks 2–6 are independent of each other. Task 7 (read path) is independent. Task 8 (web) needs Task 7 for the resolved actor column. Task 9 verifies.

---

### Task 1: `member.role_change` — actor into the repo, widened result, atomic emission

Establishes the `AuditActor` type every later task uses, and converts the one function whose guard M paid for.

**Files:**
- Modify: `packages/db/src/repos/audit.ts`
- Modify: `packages/db/src/repos/auth.ts:285-311`
- Modify: `packages/db/src/index.ts`
- Modify: `apps/api/src/auth/plugin.ts`
- Modify: `apps/api/src/routes/workspaces.ts:107-127`
- Modify: `packages/db/test/auth.test.ts`
- Create: `apps/api/test/auditEmission.test.ts`

**Interfaces:**
- Consumes: `appendAuditEvent(db: Db, input: AuditEventInput)` and `ActorKind` from Phase 3P.
- Produces:
  ```ts
  interface AuditActor {
    actorKind: ActorKind;
    actorUserId?: string | null;
    actorApiKeyId?: string | null;
    actorLabel?: string | null;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }
  interface AuditEventInput extends AuditActor { /* workspaceId, action, targetType, targetId, outcome, metadata */ }
  type UpdateMemberRoleResult =
    | { outcome: 'ok'; previousRole: Role }
    | { outcome: 'not_member' }
    | { outcome: 'last_owner' };
  function updateMemberRole(pool: pg.Pool, args: { workspaceId: string; userId: string; role: Role; actor: AuditActor }): Promise<UpdateMemberRoleResult>;
  function auditActor(req: FastifyRequest): AuditActor;  // apps/api
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/auditEmission.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { addMemberWithRole, createApiKeyClient, createAuthedUser, type AuthedUser } from './authHelpers.js';

let pool: Pool;
let app: FastifyInstance;
let owner: AuthedUser;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  owner = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
});

/** Audit rows for one action in the owner's workspace, oldest first. */
async function rows(action: string): Promise<
  {
    action: string;
    target_type: string | null;
    target_id: string | null;
    actor_kind: string;
    actor_user_id: string | null;
    actor_api_key_id: string | null;
    outcome: string;
    metadata: Record<string, unknown>;
  }[]
> {
  const r = await pool.query(
    `SELECT action, target_type, target_id, actor_kind, actor_user_id, actor_api_key_id, outcome, metadata
       FROM audit_events WHERE workspace_id = $1 AND action = $2 ORDER BY id`,
    [owner.workspaceId, action],
  );
  return r.rows as never;
}

describe('member.role_change', () => {
  test('records the previous and new role, attributed to the acting user', async () => {
    const member = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await owner.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${member.userId}`,
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    const found = await rows('member.role_change');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'user',
      target_id: member.userId,
      actor_kind: 'user',
      actor_user_id: owner.userId,
      outcome: 'success',
      metadata: { previousRole: 'viewer', newRole: 'admin' },
    });
  });

  test('a refused last-owner demotion emits nothing', async () => {
    const res = await owner.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${owner.userId}`,
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
    expect(await rows('member.role_change')).toHaveLength(0);
  });

  test('a 404 for an unknown member emits nothing', async () => {
    const res = await owner.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${randomUUID()}`,
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(404);
    expect(await rows('member.role_change')).toHaveLength(0);
  });

  test('a refused owner grant by a non-owner emits nothing', async () => {
    const admin = await addMemberWithRole(app, pool, owner.workspaceId, 'admin');
    const target = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await admin.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${target.userId}`,
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
    expect(await rows('member.role_change')).toHaveLength(0);
  });

  test('an api-key caller is recorded as the api_key actor', async () => {
    const member = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    const key = await createApiKeyClient(app, owner, 'admin');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await key.inject({
      method: 'PUT',
      url: `/v1/workspaces/members/${member.userId}`,
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(200);
    const found = await rows('member.role_change');
    expect(found[0]).toMatchObject({
      actor_kind: 'api_key',
      actor_api_key_id: key.id,
      actor_user_id: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts
```

Expected: FAIL — no `member.role_change` rows exist.

- [ ] **Step 3: Add `AuditActor` and make `AuditEventInput` extend it**

In `packages/db/src/repos/audit.ts`, replace the `AuditEventInput` interface with:

```ts
/**
 * Who did it, and from where. Split out of AuditEventInput so a repository function can
 * accept the actor without also accepting the action — and so apps/api's auditActor(req)
 * has one authoritative shape to return rather than a structurally-similar literal.
 */
export interface AuditActor {
  actorKind: ActorKind;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  /** Email for an anonymous attempt, or a retained label once the user row is gone. */
  actorLabel?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEventInput extends AuditActor {
  workspaceId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  metadata?: AuditMetadata;
}
```

Nothing else in that file changes — the field names are identical, so `appendAuditEvent` is untouched.

- [ ] **Step 4: Export it**

In `packages/db/src/index.ts` the line `export * from './repos/audit.js';` already re-exports it. Confirm with:

```bash
cd "<repo-root>" && grep -n "repos/audit" packages/db/src/index.ts
```

Expected: `export * from './repos/audit.js';`

- [ ] **Step 5: Annotate `auditActor`**

In `apps/api/src/auth/plugin.ts`, import the type and replace the inline return type:

```ts
import { getActiveApiKey, getActiveSession, getMembership, hashToken, listMemberships, type AuditActor, type Role } from '@xperiment/db';
```

```ts
export function auditActor(req: FastifyRequest): AuditActor {
  const ctx = authOf(req);
  return {
    actorKind: ctx.apiKeyId ? 'api_key' : 'user',
    actorUserId: ctx.userId,
    actorApiKeyId: ctx.apiKeyId,
    requestId: req.id,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}
```

Annotating rather than inferring means a drift between the helper and the interface becomes a compile error.

- [ ] **Step 6: Convert `updateMemberRole`**

In `packages/db/src/repos/auth.ts`, add the import at the top:

```ts
import { appendAuditEvent, type AuditActor } from './audit.js';
```

Then replace the function at line 285:

```ts
export type UpdateMemberRoleResult =
  | { outcome: 'ok'; previousRole: Role }
  | { outcome: 'not_member' }
  | { outcome: 'last_owner' };

/**
 * Owns its transaction because `pg_advisory_xact_lock` only holds until commit — row locks
 * alone let two concurrent demotions of different owners both pass the guard and strand a
 * workspace with zero owners. That is also why the actor is passed in rather than the
 * caller supplying a client: a caller who passed a pool would acquire and instantly
 * release the lock, and the guard would silently stop working.
 */
export async function updateMemberRole(
  pool: pg.Pool,
  args: { workspaceId: string; userId: string; role: Role; actor: AuditActor },
): Promise<UpdateMemberRoleResult> {
  return withTx(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workspace_role:${args.workspaceId}`]);
    const current = await client.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`,
      [args.workspaceId, args.userId],
    );
    if (!current.rowCount) return { outcome: 'not_member' };
    const was = (current.rows[0] as { role: Role }).role;
    if (was === 'owner' && args.role !== 'owner') {
      const owners = await client.query(
        `SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
        [args.workspaceId],
      );
      if ((owners.rows[0] as { c: number }).c <= 1) return { outcome: 'last_owner' };
    }
    await client.query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [
      args.workspaceId,
      args.userId,
      args.role,
    ]);
    // Same transaction and the same advisory lock as the change itself, so the record
    // cannot survive a rollback nor be lost when the change commits.
    await appendAuditEvent(client, {
      ...args.actor,
      workspaceId: args.workspaceId,
      action: 'member.role_change',
      targetType: 'user',
      targetId: args.userId,
      metadata: { previousRole: was, newRole: args.role },
    });
    return { outcome: 'ok', previousRole: was };
  });
}
```

- [ ] **Step 7: Update the route**

In `apps/api/src/routes/workspaces.ts`, import `auditActor` alongside `authOf`:

```ts
import { auditActor, authOf, requirePermission } from '../auth/plugin.js';
```

Then in the `PUT /v1/workspaces/members/:userId` handler replace the call and its result checks:

```ts
    const result = await updateMemberRole(deps.pool, {
      workspaceId: ctx.workspaceId,
      userId,
      role: parsed.data.role,
      actor: auditActor(req),
    });
    if (result.outcome === 'not_member') return sendProblem(reply, 404, 'Member not found');
    if (result.outcome === 'last_owner') {
      return sendProblem(reply, 409, 'Cannot demote the last owner', 'Promote another owner first');
    }
    return { userId, role: parsed.data.role };
```

- [ ] **Step 8: Update the db test callers**

`packages/db/test/auth.test.ts` compares the old string result. Find them:

```bash
cd "<repo-root>" && grep -n "updateMemberRole" packages/db/test/auth.test.ts
```

For each call, add `actor: { actorKind: 'system' }` to the args and change the assertion from
`toBe('ok')` to `toMatchObject({ outcome: 'ok' })` (likewise `'not_member'`, `'last_owner'`).
A `system` actor is correct here: these tests exercise the repo directly with no request.

- [ ] **Step 9: Run the tests**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts && pnpm --filter @xperiment/db test && pnpm --filter @xperiment/api test
```

Expected: PASS everywhere.

- [ ] **Step 10: Prove the emission is inside the transaction**

Temporarily change `appendAuditEvent(client, {` to `appendAuditEvent(pool, {` in
`updateMemberRole`, and add `throw new Error('injected');` immediately after it. Run:

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts -t "records the previous and new role"
```

The role change rolls back but the audit row survives — an orphan record of a change that
did not happen. Restore both edits (`client`, and remove the throw), re-run, and confirm
green.

- [ ] **Step 11: Typecheck and commit**

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/api typecheck
git add packages/db/src/repos/audit.ts packages/db/src/repos/auth.ts apps/api/src/auth/plugin.ts apps/api/src/routes/workspaces.ts packages/db/test/auth.test.ts apps/api/test/auditEmission.test.ts
git commit -m "feat: audit member role changes inside the role-change transaction"
```

---

### Task 2: `invite.create` and `invite.accept`

**Files:**
- Modify: `packages/db/src/repos/auth.ts:132-140` (`createInvite`), `:156-194` (`acceptInvite`)
- Modify: `apps/api/src/routes/workspaces.ts:42-60,62-78`
- Test: `apps/api/test/auditEmission.test.ts`

**Interfaces:**
- Consumes: `AuditActor`, `appendAuditEvent` (Task 1).
- Produces:
  ```ts
  function createInvite(db: Db, args: { workspaceId: string; tokenHash: string; role: Role; expiresAt: Date }): Promise<{ id: string }>;
  type AcceptInviteResult =
    | { outcome: 'joined'; workspaceId: string; inviteId: string; role: Role; alreadyMember: boolean }
    | { outcome: 'invalid' }
    | { outcome: 'quota_exceeded'; used: number; limit: number };
  function acceptInvite(pool: pg.Pool, tokenHash: string, userId: string, actor: AuditActor): Promise<AcceptInviteResult>;
  ```

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/auditEmission.test.ts`:

```ts
describe('invite.create and invite.accept', () => {
  test('creating an invite records the role and never the token', async () => {
    const res = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'builder' } });
    expect(res.statusCode).toBe(201);
    const token = res.json<{ token: string }>().token;
    const found = await rows('invite.create');
    expect(found).toHaveLength(1);
    expect(found[0]!.target_type).toBe('invite');
    expect(found[0]!.target_id).not.toBeNull();
    expect(found[0]!.metadata).toMatchObject({ role: 'builder' });
    // The token is shown once to the caller and must never be recoverable from the log.
    expect(JSON.stringify(found[0])).not.toContain(token);
  });

  test('accepting an invite records the granted role against the same invite id', async () => {
    const created = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'operator' } });
    const token = created.json<{ token: string }>().token;
    const inviteId = (await rows('invite.create'))[0]!.target_id;
    const joiner = await createAuthedUser(app);
    const res = await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token } });
    expect(res.statusCode).toBe(200);
    const found = await rows('invite.accept');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'invite',
      target_id: inviteId,
      actor_kind: 'user',
      actor_user_id: joiner.userId,
      metadata: { role: 'operator', alreadyMember: false },
    });
  });

  test('re-accepting as an existing member records alreadyMember and grants nothing', async () => {
    const member = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    const created = await owner.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'admin' } });
    const token = created.json<{ token: string }>().token;
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await member.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token } });
    expect(res.statusCode).toBe(200);
    expect((await rows('invite.accept'))[0]!.metadata).toMatchObject({ alreadyMember: true });
    // ON CONFLICT DO NOTHING: the existing role is untouched, so the row must not imply a grant.
    const role = await pool.query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [owner.workspaceId, member.userId],
    );
    expect(role.rows[0]!.role).toBe('viewer');
  });

  test('an invalid token emits nothing', async () => {
    const joiner = await createAuthedUser(app);
    const res = await joiner.inject({ method: 'POST', url: '/v1/invites/accept', payload: { token: 'qs_nonsense' } });
    expect(res.statusCode).toBe(404);
    const any = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'invite.accept'`,
    );
    expect(any.rows[0]!.c).toBe('0');
  });

  test('a refused owner-grant invite emits nothing', async () => {
    const admin = await addMemberWithRole(app, pool, owner.workspaceId, 'admin');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await admin.inject({ method: 'POST', url: '/v1/workspaces/invites', payload: { role: 'owner' } });
    expect(res.statusCode).toBe(403);
    expect(await rows('invite.create')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts -t "invite"
```

Expected: FAIL — no invite rows exist.

- [ ] **Step 3: `createInvite` returns its id**

In `packages/db/src/repos/auth.ts` replace `createInvite`:

```ts
/**
 * Returns the invite id so the audit row can target it. The row is otherwise keyed by
 * token_hash, which must never be logged, so without this both invite actions would have
 * a null target and the (workspace_id, target_type, target_id) index could not follow one
 * invite from creation to acceptance.
 */
export async function createInvite(
  db: Db,
  args: { workspaceId: string; tokenHash: string; role: Role; expiresAt: Date },
): Promise<{ id: string }> {
  const r = await db.query(
    `INSERT INTO workspace_invites (workspace_id, token_hash, role, expires_at) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [args.workspaceId, args.tokenHash, args.role, args.expiresAt],
  );
  return { id: (r.rows[0] as { id: string }).id };
}
```

- [ ] **Step 4: `acceptInvite` widens and emits**

Replace `acceptInvite`:

```ts
export type AcceptInviteResult =
  | { outcome: 'joined'; workspaceId: string; inviteId: string; role: Role; alreadyMember: boolean }
  | { outcome: 'invalid' }
  | { outcome: 'quota_exceeded'; used: number; limit: number };

export async function acceptInvite(
  pool: pg.Pool,
  tokenHash: string,
  userId: string,
  actor: AuditActor,
): Promise<AcceptInviteResult> {
  return withTx(pool, async (client) => {
    const invite = await client.query(
      `SELECT id, workspace_id, role FROM workspace_invites
       WHERE token_hash = $1 AND accepted_by IS NULL AND expires_at > now() FOR UPDATE`,
      [tokenHash],
    );
    if (!invite.rowCount) return { outcome: 'invalid' };
    const row = invite.rows[0] as { id: string; workspace_id: string; role: Role };
    const workspaceId = row.workspace_id;

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`workspace_role:${workspaceId}`]);

    // Re-joining an existing membership consumes no seat, so only count the new ones.
    const already = await client.query(`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
      workspaceId,
      userId,
    ]);
    const alreadyMember = (already.rowCount ?? 0) > 0;
    if (!alreadyMember) {
      const plan = await getWorkspacePlan(client, workspaceId);
      const limit = resolveLimits(plan.planCode, plan.limitOverrides).members;
      if (limit !== null && !plan.allowOverage) {
        const seats = await client.query(`SELECT count(*)::int AS c FROM workspace_members WHERE workspace_id = $1`, [
          workspaceId,
        ]);
        const used = (seats.rows[0] as { c: number }).c;
        if (used >= limit) return { outcome: 'quota_exceeded', used, limit };
      }
    }

    await client.query(`UPDATE workspace_invites SET accepted_by = $1 WHERE token_hash = $2`, [userId, tokenHash]);
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, row.role],
    );
    // alreadyMember is not cosmetic: the insert above does nothing for an existing member,
    // so a row claiming a grant would be false.
    await appendAuditEvent(client, {
      ...actor,
      workspaceId,
      action: 'invite.accept',
      targetType: 'invite',
      targetId: row.id,
      metadata: { role: row.role, alreadyMember },
    });
    return { outcome: 'joined', workspaceId, inviteId: row.id, role: row.role, alreadyMember };
  });
}
```

- [ ] **Step 5: Update both routes**

In `apps/api/src/routes/workspaces.ts`, the invite-creation handler:

```ts
    const { token, hash } = generateToken('qs');
    await withTx(deps.pool, async (client) => {
      const invite = await createInvite(client, {
        workspaceId: ctx.workspaceId,
        tokenHash: hash,
        role: parsed.data.role,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'invite.create',
        targetType: 'invite',
        targetId: invite.id,
        // Never the token or its hash.
        metadata: { role: parsed.data.role, expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() },
      });
    });
    // Email delivery is deferred; the caller distributes the token.
    return reply.status(201).send({ token });
```

and the accept handler:

```ts
    const result = await acceptInvite(deps.pool, hashToken(parsed.data.token), ctx.userId, auditActor(req));
```

Add `appendAuditEvent` and `withTx` to the `@xperiment/db` import at the top of the file.

- [ ] **Step 6: Fix the expiry duplication**

Step 5 computes `new Date(Date.now() + INVITE_TTL_MS)` twice, which can differ by a
millisecond. Hoist it:

```ts
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
```

and use `expiresAt` in both places, with `expiresAt: expiresAt.toISOString()` in metadata.

- [ ] **Step 7: Update other callers**

```bash
cd "<repo-root>" && grep -rn "acceptInvite\|createInvite" --include=*.ts apps packages | grep -v "repos/auth.ts"
```

Update each db-test call: `acceptInvite(pool, hash, userId, { actorKind: 'system' })`, and
assertions from `result.outcome === 'joined'` stay valid. `createInvite` callers now get
`{ id }` — existing ones ignore the return, which still compiles.

- [ ] **Step 8: Run the tests**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts && pnpm --filter @xperiment/db test && pnpm --filter @xperiment/api test
```

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/api typecheck
git add packages/db/src/repos/auth.ts apps/api/src/routes/workspaces.ts packages/db/test apps/api/test/auditEmission.test.ts
git commit -m "feat: audit invite creation and acceptance"
```

---

### Task 3: `workspace.create`

**Files:**
- Modify: `packages/db/src/repos/auth.ts:74-90`
- Modify: `apps/api/src/routes/workspaces.ts:26-33`
- Test: `apps/api/test/auditEmission.test.ts`

**Interfaces:**
- Consumes: `AuditActor`, `appendAuditEvent`.
- Produces: `createWorkspaceWithOwner(pool: pg.Pool, args: { name: string; userId: string; actor: AuditActor }): Promise<{ id: string; name: string }>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/auditEmission.test.ts`:

```ts
describe('workspace.create', () => {
  test('records the new workspace against itself, attributed to its creator', async () => {
    const creator = await createAuthedUser(app);
    const res = await creator.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'Second' } });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; name: string }>();
    const r = await pool.query<{ target_id: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      `SELECT target_id, actor_user_id, metadata FROM audit_events
        WHERE workspace_id = $1 AND action = 'workspace.create'`,
      [created.id],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      target_id: created.id,
      actor_user_id: creator.userId,
      metadata: { name: 'Second' },
    });
  });

  test('an invalid name emits nothing', async () => {
    const creator = await createAuthedUser(app);
    const before = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'workspace.create'`,
    );
    const res = await creator.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    const after = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'workspace.create'`,
    );
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts -t "workspace.create"
```

Expected: FAIL — zero rows.

- [ ] **Step 3: Convert `createWorkspaceWithOwner`**

In `packages/db/src/repos/auth.ts`, add the actor and the emission inside the existing
transaction. The audit row references the workspace created in the same transaction, which
satisfies the foreign key because both commit together:

```ts
export async function createWorkspaceWithOwner(
  pool: pg.Pool,
  args: { name: string; userId: string; actor: AuditActor },
): Promise<{ id: string; name: string }> {
  return withTx(pool, async (client) => {
    const ws = await client.query(
      `INSERT INTO workspaces (id, name) VALUES (gen_random_uuid(), $1) RETURNING id, name`,
      [args.name],
    );
    const row = ws.rows[0] as { id: string; name: string };
    await client.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      row.id,
      args.userId,
    ]);
    await appendAuditEvent(client, {
      ...args.actor,
      workspaceId: row.id,
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: row.id,
      metadata: { name: row.name },
    });
    return row;
  });
}
```

If the existing body differs from the two inserts shown, keep the existing statements and
add only the `appendAuditEvent` call and the `actor` arg — do not rewrite working SQL.

- [ ] **Step 4: Update the route**

In `apps/api/src/routes/workspaces.ts`:

```ts
    const ws = await createWorkspaceWithOwner(deps.pool, {
      name: parsed.data.name,
      userId: ctx.userId,
      actor: auditActor(req),
    });
```

- [ ] **Step 5: Update other callers**

```bash
cd "<repo-root>" && grep -rn "createWorkspaceWithOwner" --include=*.ts apps packages | grep -v "repos/auth.ts"
```

`apps/api/src/routes/auth.ts` calls it during registration — that call is outside the auth
plugin so `auditActor(req)` is unavailable; pass the registering user explicitly:

```ts
      actor: {
        actorKind: 'user',
        actorUserId: user.id,
        actorLabel: user.email,
        requestId: req.id,
        ip: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      },
```

Db tests pass `actor: { actorKind: 'system' }`.

- [ ] **Step 6: Run the tests and commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/api typecheck
git add packages/db/src/repos/auth.ts apps/api/src/routes apps/api/test packages/db/test
git commit -m "feat: audit workspace creation"
```

---

### Task 4: `api_key.create` and `api_key.revoke`

Both repo functions take a `Db`, so the route owns the transaction — the pattern P used for
connections.

**Files:**
- Modify: `apps/api/src/routes/workspaces.ts:80-99,135-142`
- Test: `apps/api/test/auditEmission.test.ts`

**Interfaces:**
- Consumes: `createApiKey(db: Db, args)`, `revokeApiKey(db: Db, id, workspaceId): Promise<boolean>`, `auditActor`, `appendAuditEvent`, `withTx`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
describe('api_key.create and api_key.revoke', () => {
  test('creating a key records its name and role, and never the key itself', async () => {
    const res = await owner.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'CI', role: 'builder' } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; key: string }>();
    const found = await rows('api_key.create');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'api_key',
      target_id: body.id,
      metadata: { name: 'CI', role: 'builder' },
    });
    // The key is shown once and must never be recoverable from the log.
    expect(JSON.stringify(found[0])).not.toContain(body.key);
  });

  test('revoking a key is audited, and a second revoke is a 404 that emits nothing', async () => {
    const created = await owner.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'Temp' } });
    const id = created.json<{ id: string }>().id;
    await pool.query(`TRUNCATE audit_events CASCADE`);
    expect((await owner.inject({ method: 'DELETE', url: `/v1/api-keys/${id}` })).statusCode).toBe(204);
    expect((await owner.inject({ method: 'DELETE', url: `/v1/api-keys/${id}` })).statusCode).toBe(404);
    const found = await rows('api_key.revoke');
    expect(found).toHaveLength(1);
    expect(found[0]!.target_id).toBe(id);
  });

  test('a refused owner-role key emits nothing', async () => {
    const admin = await addMemberWithRole(app, pool, owner.workspaceId, 'admin');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await admin.inject({ method: 'POST', url: '/v1/api-keys', payload: { name: 'X', role: 'owner' } });
    expect(res.statusCode).toBe(403);
    expect(await rows('api_key.create')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts -t "api_key"
```

Expected: FAIL — zero rows.

- [ ] **Step 3: Wrap the create handler**

```ts
    const { token, hash } = generateToken('qk');
    const row = await withTx(deps.pool, async (client) => {
      const created = await createApiKey(client, {
        workspaceId: ctx.workspaceId,
        name: parsed.data.name,
        keyHash: hash,
        ...(parsed.data.role ? { role: parsed.data.role } : {}),
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: created.id,
        // Never the token or its hash.
        metadata: { name: created.name, role: created.role },
      });
      return created;
    });
    return reply.status(201).send({ id: row.id, name: row.name, role: row.role, key: token }); // shown once
```

- [ ] **Step 4: Wrap the revoke handler**

```ts
    const revoked = await withTx(deps.pool, async (client) => {
      const ok = await revokeApiKey(client, id, ctx.workspaceId);
      if (!ok) return false;
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'api_key.revoke',
        targetType: 'api_key',
        targetId: id,
      });
      return true;
    });
    if (!revoked) return sendProblem(reply, 404, 'Api key not found');
    return reply.status(204).send();
```

`revokeApiKey`'s `UPDATE … WHERE revoked_at IS NULL` is already a compare-and-set, so a
concurrent double revoke emits exactly one row.

- [ ] **Step 5: Run the tests and commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/workspaces.ts apps/api/test/auditEmission.test.ts
git commit -m "feat: audit api key creation and revocation"
```

---

### Task 5: `plan.change`

**Files:**
- Modify: `apps/api/src/routes/plan.ts:80-110`
- Test: `apps/api/test/auditEmission.test.ts`

**Interfaces:**
- Consumes: `getWorkspacePlan(db: Db, workspaceId)`, `setWorkspacePlan(db: Db, args)`, both `Db`-taking.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
describe('plan.change', () => {
  test('records the previous and new plan', async () => {
    const res = await owner.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'builder' } });
    expect(res.statusCode).toBe(200);
    const found = await rows('plan.change');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'workspace',
      target_id: owner.workspaceId,
      metadata: { previousPlan: 'free', newPlan: 'builder' },
    });
  });

  test('an overage-only change records the flag and repeats the plan', async () => {
    await owner.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'builder' } });
    await pool.query(`TRUNCATE audit_events CASCADE`);
    await owner.inject({ method: 'PUT', url: '/v1/plan', payload: { allowOverage: true } });
    expect((await rows('plan.change'))[0]!.metadata).toMatchObject({
      previousPlan: 'builder',
      newPlan: 'builder',
      allowOverage: true,
    });
  });

  test('a refused downgrade emits nothing', async () => {
    // Seat the workspace above the free member limit, then try to downgrade to it.
    await owner.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'team' } });
    for (let i = 0; i < 3; i += 1) await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await owner.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'free' } });
    expect(res.statusCode).toBe(409);
    expect(await rows('plan.change')).toHaveLength(0);
  });

  test('a billing-only member cannot change the plan and emits nothing', async () => {
    const viewer = await addMemberWithRole(app, pool, owner.workspaceId, 'viewer');
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const res = await viewer.inject({ method: 'PUT', url: '/v1/plan', payload: { planCode: 'builder' } });
    expect(res.statusCode).toBe(403);
    expect(await rows('plan.change')).toHaveLength(0);
  });
});
```

If the free plan's member limit makes the downgrade test's seat count wrong, read
`PLAN_CATALOG.free.members` in `packages/plans/src/index.ts` and seat one more than that.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts -t "plan.change"
```

Expected: FAIL — zero rows.

- [ ] **Step 3: Wrap the write, reading the previous plan inside the transaction**

Replace the tail of the `PUT /v1/plan` handler:

```ts
    await withTx(deps.pool, async (client) => {
      // Read inside the transaction: setWorkspacePlan does not return the previous code,
      // and reading it outside would race a concurrent change.
      const before = await getWorkspacePlan(client, ctx.workspaceId);
      const after = await setWorkspacePlan(client, {
        workspaceId: ctx.workspaceId,
        ...(parsed.data.planCode ? { planCode: parsed.data.planCode } : {}),
        ...(parsed.data.allowOverage !== undefined ? { allowOverage: parsed.data.allowOverage } : {}),
      });
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'plan.change',
        targetType: 'workspace',
        targetId: ctx.workspaceId,
        metadata: { previousPlan: before.planCode, newPlan: after.planCode, allowOverage: after.allowOverage },
      });
    });
    return quotaSnapshot(deps.pool, ctx.workspaceId);
```

Add `appendAuditEvent`, `getWorkspacePlan` and `withTx` to the `@xperiment/db` import, and
`auditActor` to the plugin import.

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/plan.ts apps/api/test/auditEmission.test.ts
git commit -m "feat: audit plan changes with the previous plan code"
```

---

### Task 6: `invoice.pay` and `invoice.mark_paid`

**Files:**
- Modify: `apps/api/src/routes/invoices.ts:34-57,59-77`
- Test: `apps/api/test/auditEmission.test.ts`

**Interfaces:**
- Consumes: `getInvoice(db, id, workspaceId)` → `{ invoice: InvoiceRow; lines }`, `setInvoiceProvider(db, args): Promise<boolean>`, `markInvoicePaid(db, args): Promise<boolean>`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

The suite needs an issued invoice. Seed one directly rather than running the sweep:

```ts
describe('invoice.pay and invoice.mark_paid', () => {
  async function seedIssuedInvoice(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO invoices (workspace_id, period_start, period_end, plan_code, currency,
         subtotal_minor, tax_rate_bps, tax_minor, total_minor, status)
       VALUES ($1, '2026-06-01', '2026-07-01', 'builder', 'IDR', 149000, 1100, 16390, 165390, 'issued')
       RETURNING id`,
      [owner.workspaceId],
    );
    return r.rows[0]!.id;
  }

  test('marking an invoice paid is audited with its amount', async () => {
    const id = await seedIssuedInvoice();
    const res = await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    expect(res.statusCode).toBe(200);
    const found = await rows('invoice.mark_paid');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      target_type: 'invoice',
      target_id: id,
      metadata: { totalMinor: 165390, currency: 'IDR' },
    });
  });

  test('a replayed mark-paid is a 409 that emits nothing more', async () => {
    const id = await seedIssuedInvoice();
    await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    const again = await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/mark-paid` });
    expect(again.statusCode).toBe(409);
    expect(await rows('invoice.mark_paid')).toHaveLength(1);
  });

  test('paying an invoice is audited with the provider', async () => {
    const id = await seedIssuedInvoice();
    const res = await owner.inject({ method: 'POST', url: `/v1/invoices/${id}/pay` });
    expect(res.statusCode).toBe(200);
    const found = await rows('invoice.pay');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ target_id: id, metadata: { provider: 'manual', currency: 'IDR' } });
  });

  test('an unknown invoice emits nothing', async () => {
    const res = await owner.inject({ method: 'POST', url: `/v1/invoices/${randomUUID()}/mark-paid` });
    expect(res.statusCode).toBe(404);
    expect(await rows('invoice.mark_paid')).toHaveLength(0);
  });
});
```

Add `TRUNCATE invoices` to this file's `beforeEach` alongside `audit_events`.

If the seeded column list does not match `packages/db/src/migrations/0011_invoices.sql`,
adjust the INSERT to that schema rather than changing the schema.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/auditEmission.test.ts -t "invoice"
```

Expected: FAIL — zero rows.

- [ ] **Step 3: Wrap the mark-paid handler**

```ts
    const settled = await withTx(deps.pool, async (client) => {
      const ok = await markInvoicePaid(client, {
        id,
        workspaceId: ctx.workspaceId,
        provider: found.invoice.provider ?? deps.paymentProvider.key,
        providerRef: found.invoice.providerRef ?? 'manual-settlement',
      });
      if (!ok) return false;
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'invoice.mark_paid',
        targetType: 'invoice',
        targetId: id,
        metadata: { totalMinor: found.invoice.totalMinor, currency: found.invoice.currency },
      });
      return true;
    });
    // CAS: a replay settles nothing rather than paying twice.
    if (!settled) return sendProblem(reply, 409, 'Invoice already settled', `Status is ${found.invoice.status}`);
    return { status: 'paid' };
```

- [ ] **Step 4: Wrap the pay handler**

```ts
    const charge = await deps.paymentProvider.createCharge({
      invoiceId: found.invoice.id,
      workspaceId: ctx.workspaceId,
      totalMinor: found.invoice.totalMinor,
      currency: found.invoice.currency,
    });
    await withTx(deps.pool, async (client) => {
      await setInvoiceProvider(client, {
        id,
        workspaceId: ctx.workspaceId,
        provider: deps.paymentProvider.key,
        providerRef: charge.reference,
      });
      // Audits the local record, not the charge: createCharge already happened above, so a
      // provider success followed by a failed write leaves no row. Restructuring that is
      // out of scope for 4A.
      await appendAuditEvent(client, {
        ...auditActor(req),
        workspaceId: ctx.workspaceId,
        action: 'invoice.pay',
        targetType: 'invoice',
        targetId: id,
        metadata: {
          totalMinor: found.invoice.totalMinor,
          currency: found.invoice.currency,
          provider: deps.paymentProvider.key,
        },
      });
    });
    return { provider: deps.paymentProvider.key, ...charge };
```

Add `appendAuditEvent` and `withTx` to the `@xperiment/db` import and `auditActor` to the plugin
import in this file.

- [ ] **Step 5: Run the tests and commit**

```bash
pnpm --filter @xperiment/api test && pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/invoices.ts apps/api/test/auditEmission.test.ts
git commit -m "feat: audit invoice payment and manual settlement"
```

---

### Task 7: The read path resolves actors

**Files:**
- Modify: `packages/db/src/repos/audit.ts`
- Test: `packages/db/test/audit.test.ts`

**Interfaces:**
- Consumes: `audit_events`, `users`, `api_keys`.
- Produces: `AuditEventRow` gains `actorEmail: string | null` and `actorApiKeyName: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/audit.test.ts`, inside the `listAuditEvents` describe:

```ts
  test('resolves a user actor to an email and an api-key actor to a key name', async () => {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x')`, [
      userId,
      `who-${userId.slice(0, 8)}@example.com`,
    ]);
    const keyId = randomUUID();
    await pool.query(`INSERT INTO api_keys (id, workspace_id, name, key_hash, role) VALUES ($1,$2,'CI',$3,'builder')`, [
      keyId,
      ws,
      `hash-${keyId}`,
    ]);
    await appendAuditEvent(pool, { workspaceId: ws, actorKind: 'user', actorUserId: userId, action: 'a.b' });
    await appendAuditEvent(pool, { workspaceId: ws, actorKind: 'api_key', actorApiKeyId: keyId, action: 'a.b' });
    const found = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    const byKind = new Map(found.map((r) => [r.actorKind, r]));
    expect(byKind.get('user')!.actorEmail).toBe(`who-${userId.slice(0, 8)}@example.com`);
    expect(byKind.get('user')!.actorApiKeyName).toBeNull();
    expect(byKind.get('api_key')!.actorApiKeyName).toBe('CI');
    expect(byKind.get('api_key')!.actorEmail).toBeNull();
  });

  test('a deleted user leaves actorEmail null and actorLabel standing', async () => {
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,'x')`, [
      userId,
      `gone-${userId.slice(0, 8)}@example.com`,
    ]);
    await appendAuditEvent(pool, {
      workspaceId: ws,
      actorKind: 'user',
      actorUserId: userId,
      actorLabel: 'gone@example.com',
      action: 'a.b',
    });
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    const found = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(found[0]!.actorEmail).toBeNull();
    expect(found[0]!.actorLabel).toBe('gone@example.com');
  });

  test('an api key from another workspace is never named', async () => {
    // The join is keyed on id AND workspace_id, so a cross-workspace id cannot leak a name.
    const keyId = randomUUID();
    await pool.query(`INSERT INTO api_keys (id, workspace_id, name, key_hash, role) VALUES ($1,$2,'Foreign',$3,'builder')`, [
      keyId,
      other,
      `hash-${keyId}`,
    ]);
    await appendAuditEvent(pool, { workspaceId: ws, actorKind: 'api_key', actorApiKeyId: keyId, action: 'a.b' });
    const found = await listAuditEvents(pool, { workspaceId: ws, limit: 10 });
    expect(found[0]!.actorApiKeyName).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/audit.test.ts
```

Expected: FAIL — `actorEmail` is `undefined`.

- [ ] **Step 3: Add the fields to the row type and mapper**

In `packages/db/src/repos/audit.ts`, add to `AuditEventRow` after `actorLabel`:

```ts
  /** Resolved on read rather than denormalised on write; null once the user row is gone. */
  actorEmail: string | null;
  actorApiKeyName: string | null;
```

and to `mapEvent`:

```ts
    actorEmail: (r['actor_email'] as string | null) ?? null,
    actorApiKeyName: (r['actor_api_key_name'] as string | null) ?? null,
```

- [ ] **Step 4: Join in `listAuditEvents`**

Replace the query:

```ts
  const r = await db.query(
    `SELECT a.*, u.email AS actor_email, k.name AS actor_api_key_name
       FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_user_id
       -- Keyed on id AND workspace: a cross-workspace id must not surface another
       -- tenant's key name.
       LEFT JOIN api_keys k ON k.id = a.actor_api_key_id AND k.workspace_id = a.workspace_id
      WHERE a.workspace_id = $1
        AND ($2::bigint IS NULL OR a.id < $2::bigint)
        AND ($3::text IS NULL OR a.action = $3)
        AND ($4::text IS NULL OR a.target_type = $4)
        AND ($5::text IS NULL OR a.target_id = $5)
      ORDER BY a.id DESC
      LIMIT $6`,
    [args.workspaceId, args.before ?? null, args.action ?? null, args.targetType ?? null, args.targetId ?? null, limit],
  );
```

- [ ] **Step 5: Run the tests and commit**

```bash
pnpm --filter @xperiment/db test && pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/api test
git add packages/db/src/repos/audit.ts packages/db/test/audit.test.ts
git commit -m "feat: resolve audit actors to an email or api key name on read"
```

---

### Task 8: The audit page

**Files:**
- Create: `apps/web/src/app/(app)/audit/page.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/components/shell/Sidebar.tsx:6-16`
- Test: `apps/web/e2e/web.spec.ts`

**Interfaces:**
- Consumes: `GET /v1/audit` → `{ items: AuditEvent[]; nextBefore: string | null }`.
- Produces: `AuditEvent` and `ApiClient.listAudit` in `apps/web/src/lib/api.ts`.

- [ ] **Step 1: Add the client method and type**

In `apps/web/src/lib/api.ts`, beside `listMembers`:

```ts
  listAudit(params: { limit?: number; before?: string; action?: string } = {}): Promise<AuditPage> {
    const q = new URLSearchParams();
    if (params.limit !== undefined) q.set('limit', String(params.limit));
    if (params.before) q.set('before', params.before);
    if (params.action) q.set('action', params.action);
    const qs = q.toString();
    return this.request('GET', `/v1/audit${qs ? `?${qs}` : ''}`);
  }
```

and beside `WorkspaceMember`:

```ts
export interface AuditEvent {
  id: string;
  actorKind: 'user' | 'api_key' | 'system' | 'anonymous';
  actorEmail: string | null;
  actorApiKeyName: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure';
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEvent[];
  nextBefore: string | null;
}
```

- [ ] **Step 2: Add the nav entry**

In `apps/web/src/components/shell/Sidebar.tsx`, after the Members entry:

```ts
  { href: '/audit', label: 'Audit' },
```

- [ ] **Step 3: Write the page**

Create `apps/web/src/app/(app)/audit/page.tsx`:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PermissionNotice } from '../../../components/ui/PermissionNotice';
import { getBrowserClient, type AuditEvent } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

const PAGE = 50;

/**
 * Privilege and credential-lifecycle actions first, then the high-volume worker one.
 * credential.read_use emits a row per node per execution, so on a busy workspace it
 * dominates the unfiltered list — the filter is how you get past it. The default view is
 * deliberately unfiltered: an audit log that silently omits rows is worse than a noisy one.
 */
const ACTIONS = [
  'member.role_change',
  'api_key.create',
  'api_key.revoke',
  'invite.create',
  'invite.accept',
  'plan.change',
  'invoice.pay',
  'invoice.mark_paid',
  'workspace.create',
  'credential.create',
  'credential.delete',
  'credential.test',
  'trigger_secret.reveal',
  'secret.rekey_batch',
  'auth.register',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.logout',
  'auth.logout_all',
  'credential.read_use',
] as const;

function actorOf(e: AuditEvent): string {
  if (e.actorEmail) return e.actorEmail;
  if (e.actorApiKeyName) return `${e.actorApiKeyName} (api key)`;
  if (e.actorLabel) return e.actorLabel;
  return e.actorKind;
}

function targetOf(e: AuditEvent): string {
  if (!e.targetType) return '—';
  return e.targetId ? `${e.targetType} ${e.targetId.slice(0, 8)}` : e.targetType;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [pages, setPages] = useState<string[]>([]); // cursors already followed

  const before = pages[pages.length - 1];
  const auditQ = useQuery({
    queryKey: ['audit', action, before ?? ''],
    queryFn: () =>
      getBrowserClient().listAudit({
        limit: PAGE,
        ...(before ? { before } : {}),
        ...(action ? { action } : {}),
      }),
    retry: false,
  });

  const forbidden = forbiddenDetail(auditQ.error);

  return (
    <div data-testid="audit-page">
      <div className="q-page-head">
        <h1>Audit</h1>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : (
        <>
          <div style={{ marginBottom: '1rem' }}>
            <select
              className="q-select"
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPages([]); // a new filter starts a new pagination run
              }}
              data-testid="audit-action-filter"
              aria-label="Filter by action"
            >
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          {auditQ.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : null}
          {auditQ.isError && !forbidden ? <div className="q-banner">Could not load the audit log.</div> : null}

          {auditQ.data ? (
            auditQ.data.items.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }} data-testid="audit-empty">
                No events recorded yet.
              </p>
            ) : (
              <>
                <table className="q-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditQ.data.items.map((e) => (
                      <tr key={e.id} data-testid={`audit-${e.id}`}>
                        <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(e.createdAt)}</td>
                        <td>{actorOf(e)}</td>
                        <td>{e.action}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{targetOf(e)}</td>
                        <td>{e.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {auditQ.data.nextBefore ? (
                  <button
                    type="button"
                    className="q-button"
                    onClick={() => setPages((p) => [...p, auditQ.data!.nextBefore!])}
                    data-testid="audit-load-more"
                  >
                    Load more
                  </button>
                ) : null}
              </>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
```

If `q-button` or `q-select` are not the class names used elsewhere, copy the ones the
Members and Plan pages use rather than inventing new ones.

- [ ] **Step 4: Run the web unit suite and typecheck**

```bash
pnpm --filter @xperiment/web test && pnpm --filter @xperiment/web typecheck
```

Expected: PASS.

- [ ] **Step 5: Add the Playwright case**

Append to `apps/web/e2e/web.spec.ts`, following the file's existing register/login helper:

```ts
test('an admin reads the audit log and filters it', async ({ page }) => {
  await registerAndLogin(page); // the file's existing helper
  await page.getByTestId('nav-audit').click();
  await expect(page.getByTestId('audit-page')).toBeVisible();
  // Registration itself emits auth.register and workspace.create, so the log is never empty.
  await expect(page.locator('table.q-table tbody tr').first()).toBeVisible();
  await page.getByTestId('audit-action-filter').selectOption('workspace.create');
  await expect(page.locator('table.q-table tbody tr')).toHaveCount(1);
});
```

If `registerAndLogin` is named differently in that file, use the existing helper — do not
add a second one.

**The viewer refusal is deliberately not a Playwright case.** The browser fixture registers
a user who owns their workspace, so making them a viewer would mean creating a second
workspace, inviting, accepting and switching — a lot of fixture for an assertion already
covered at the api level by `apps/api/test/audit.test.ts` → "a viewer is refused, and the
message names the permission", which P shipped. Do not duplicate it here.

- [ ] **Step 6: Run Playwright**

```bash
pnpm --filter @xperiment/web e2e
```

Expected: PASS, 8 tests. The config starts the whole stack itself via
`e2e/setup.global.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src apps/web/e2e
git commit -m "feat: add the workspace audit log page"
```

---

### Task 9: Full verification

**Files:** none — this task only runs gates.

- [ ] **Step 1: Confirm every action is reachable and emitting**

```bash
cd "<repo-root>" && docker exec postgres psql -U postgres -d xperiment -c "SELECT action, count(*) FROM audit_events GROUP BY action ORDER BY action;"
```

Expected: the nine 4A actions appear after the api suite has run. Any missing action means
its emission is unreachable — find the route rather than adjusting the test.

- [ ] **Step 2: No secret material in any audit row**

```bash
cd "<repo-root>" && docker exec postgres psql -U postgres -d xperiment -c "SELECT count(*) AS suspicious FROM audit_events WHERE metadata::text ~* '(token|secret|password|key_hash|qs_|qk_)';"
```

Expected: `0`. A non-zero count means a call site put credential material in metadata.

- [ ] **Step 3: Full suite**

```bash
pnpm test
```

Expected: every package green. **Not `pnpm -r test`** — that runs packages concurrently and
`@xperiment/queue`'s outbox publisher then races other suites over `task_outbox`.

- [ ] **Step 4: Coverage and typecheck**

```bash
pnpm test:cov && pnpm -r typecheck
```

Expected: exit 0, no threshold failures, no type errors.

- [ ] **Step 5: End-to-end**

```bash
pnpm --filter @xperiment/e2e test && pnpm --filter @xperiment/web e2e
```

Expected: 24 scenario tests and 8 Playwright specs pass.

- [ ] **Step 6: Commit any test fixes**

```bash
git add -A
git commit -m "test: keep the suite green after the audit emission work"
```

If nothing changed, skip the commit rather than creating an empty one.

---

## Self-Review

**1. Spec coverage.**

| Spec section | Task |
|---|---|
| §3 `AuditActor` and the `auditActor` annotation | 1 |
| §4 `UpdateMemberRoleResult` | 1 |
| §4 `AcceptInviteResult`, `createInvite` returning `{id}` | 2 |
| §5 `member.role_change` | 1 |
| §5 `invite.create`, `invite.accept` | 2 |
| §5 `workspace.create` | 3 |
| §5 `api_key.create`, `api_key.revoke` | 4 |
| §5 `plan.change` incl. the previous plan read inside the tx | 5 |
| §5 `invoice.pay`, `invoice.mark_paid` | 6 |
| §5 no token in metadata | 2, 4 assert it per route; 9 Step 2 sweeps the whole table |
| §6 resolved actors, api-key join on id AND workspace | 7 |
| §7 the page, filter, load-more, PermissionNotice | 8 |
| §8 one row on success / zero on each refusal | 1–6, one test per refusal path |
| §8 atomicity break-it check | 1 Step 10 |
| §8 Playwright admin-vs-viewer | 8 Step 5 |

**One gap found and closed inline:** §8 asks for both an admin seeing rows and a viewer
seeing the permission notice, but Task 8 Step 5's Playwright case was named for both while
its body only exercised the admin. Making a viewer in the browser means creating a second
workspace, inviting, accepting and switching — a lot of fixture for an assertion P already
covers at the api level (`apps/api/test/audit.test.ts` → "a viewer is refused, and the
message names the permission"). Task 8 Step 5 is now renamed to `an admin reads the audit
log and filters it` and states explicitly that the viewer refusal stays an api test rather
than being duplicated.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every
code step carries its code. Four steps say "if the existing shape differs, follow the
existing one" — for `createWorkspaceWithOwner`'s body, the invoice column list, the web
class names, and the Playwright helper name. Those are instructions to match real code the
implementer can read, not deferred decisions.

**3. Type consistency.**

- `AuditActor` field names are identical to `AuditEventInput`'s, which is what makes
  `{ ...args.actor }` spread legally — and Task 1 Step 3 makes `AuditEventInput extend
  AuditActor` so they cannot drift.
- `{ outcome: 'ok' | 'not_member' | 'last_owner' }` is used as `result.outcome === …` in
  Task 1 Step 7 and nowhere is the old bare string compared.
- `acceptInvite` takes the actor as a fourth positional argument (Task 2), while
  `updateMemberRole` and `createWorkspaceWithOwner` take it inside their args object (Tasks
  1, 3). That asymmetry mirrors each function's existing signature — `acceptInvite` is
  already positional — and is deliberate rather than an oversight.
- `AuditEventRow.actorEmail` / `.actorApiKeyName` (Task 7) match the web `AuditEvent` fields
  (Task 8) exactly.
- `nextBefore` is a `string | null` in both the endpoint (P) and the web type (Task 8).

