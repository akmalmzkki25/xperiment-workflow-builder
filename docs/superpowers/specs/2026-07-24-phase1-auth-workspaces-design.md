# Phase 1 Sub-project C: Auth + Workspaces — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (A + B merged); branch `feature/phase1-auth`
**PRD requirements covered:** AUTH-001 (email/password half), AUTH-003, AUTH-007,
AUTH-008, WS-001, WS-002 (4-role subset), WS-003, WS-004 (token-based, email delivery
deferred), API-001 (scoped API keys).
**Deferred:** Google OAuth (needs cloud OAuth app), email verification/reset + emailed
invites (needs email provider), MFA (AUTH-004), SSO/SCIM, custom roles (WS-006),
projects/environments (WS-005/007), quotas (WS-009), workspace deletion grace (WS-010).

---

## 1. Goal

Multiple users, multiple isolated workspaces, enforced at the API: every control-plane
request runs in an authenticated workspace context; cross-tenant access is impossible by
construction and proven by tests. The data plane (gateway/scheduler/orchestrator/worker)
inherits tenant context from rows it reads and needs no auth.

## 2. Data model — migration `0004_auth.sql`

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- scrypt: salt_hex:hash_hex
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,      -- sha256 hex of the bearer token
  expires_at TIMESTAMPTZ NOT NULL,      -- now() + 30 days
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                   -- 'owner' | 'admin' | 'builder' | 'viewer'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,      -- now() + 7 days
  accepted_by UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,        -- sha256 hex of 'qk_...' token
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NULL,
  email CITEXT NULL,
  event_type TEXT NOT NULL,             -- login_succeeded | login_failed | logout | logout_all | register
  ip TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The seeded `default` workspace remains for the data plane's existing rows; new users get
their own workspaces.

## 3. Crypto

- Passwords: `crypto.scrypt(password, salt(16B), 32)`, stored `saltHex:hashHex`,
  verified with `timingSafeEqual`. Pure Node, no new deps.
- Session tokens: 32 random bytes base64url, prefix `qs_`; API keys prefix `qk_`.
  Only sha256 hashes stored; plaintext shown exactly once at creation.

## 4. Auth context and role gate

- Fastify `preHandler` on all `/v1` routes except `/v1/healthz`, `/v1/auth/register`,
  `/v1/auth/login`, `/v1/invites/accept`:
  1. `Authorization: Bearer qs_...` → session lookup (unexpired, unrevoked) → user.
     Workspace = `X-Xperiment-Workspace` header (must be a membership; 403 otherwise) or the
     user's oldest membership.
  2. `Authorization: Bearer qk_...` → api_keys lookup → workspace context with role
     `builder`, `userId = null`, updates `last_used_at`.
  3. Otherwise 401 problem.
- Request context: `{ userId: string | null; workspaceId: string; role: Role }`
  attached via `request.authContext`.
- Role gate helper `requireRole(ctx, minimum)` with order
  `viewer < builder < admin < owner`. Route minimums: reads → viewer; workflow/
  connection/execution writes (create, draft, validate, publish, execute, activate,
  deactivate, delete) → builder; invites + api-keys + members list → admin; (workspace
  delete deferred). Violations → 403 problem.

## 5. Tenant scoping (the structural change)

- Control-plane repos gain explicit workspace scoping: `createWorkflow`,
  `listWorkflows`, `getWorkflow`, `listConnections`, `createConnection`,
  `getConnectionWithPayload` (API paths), `listExecutions`, `getExecutionDetail`,
  `listTriggers`, `recentTestTriggerPayloads` accept/filter by `workspaceId`; lookups
  return null/empty for rows outside the workspace (404 at the API — no existence
  leaks).
- Writes derive `workspace_id` from the parent row: `createExecutionWithTrigger`,
  `upsertTrigger`, `createVersion`, drafts, node/event/outbox inserts take it from the
  workflow row (SQL subselect) — the `DEFAULT_WORKSPACE_ID` constant disappears from
  runtime code paths (kept only for the seed).
- Data plane: gateway resolves the trigger row (already workspace-bound), worker and
  scheduler read execution/workflow rows — no changes beyond the repo signatures.
- **Isolation tests (mandatory):** user B's session cannot get/list/execute/activate
  user A's workflows, connections, executions, or trigger samples (all 404/empty);
  api-key of workspace A cannot touch workspace B.

## 6. API

```text
POST /v1/auth/register        { email, password } -> 201 { token, user, workspace }   (rate-limited)
POST /v1/auth/login           { email, password } -> { token }                        (rate-limited 5/min per email+ip)
POST /v1/auth/logout          revoke current session -> 204
POST /v1/auth/logout-all      revoke all sessions of the user -> 204                  (AUTH-003)
GET  /v1/auth/me              { user, workspaces: [{ id, name, role }] }
POST /v1/workspaces           { name } -> 201 (creator becomes owner)
GET  /v1/workspaces           memberships of the current user
POST /v1/workspaces/invites   { role } -> 201 { token }  (admin+; current workspace; email delivery deferred)
POST /v1/invites/accept       { token } -> { workspaceId }  (auth required: session user joins)
POST /v1/api-keys             { name } -> 201 { key }  (admin+; shown once)
GET  /v1/api-keys             list (no hashes)
DELETE /v1/api-keys/:id       revoke -> 204
```

- Password rules: min 8 chars. Register conflict → 409. Login failure → generic 401
  (no user-exists leak) + `auth_events` row; 6th failure within a minute → 429.
- All auth events (register, login ok/fail, logout, logout-all) append to `auth_events`.

## 7. Service/test fallout

- API `buildServer` gains the auth plugin; every existing API test authenticates via a
  `authedInject` helper (register+login once per suite, bearer attached).
- E2E `helpers.api()` registers+logs in one shared user in `prepareDatabase()` and
  attaches the bearer automatically — scenario files unchanged beyond that.
- CLI: `xperiment login` stores the token in `~/.xperiment/credentials.json` (0600); `ApiClient`
  sends it; `XPERIMENT_TOKEN` env overrides (used by tests/e2e).
- Gateway/scheduler/orchestrator/worker: signature-level updates only where repos
  changed.

## 8. Testing

Unit: scrypt hash/verify + timing-safe compare, token generate/hash, role ordering,
rate-limiter window. Integration: register/login/logout(-all) flows incl. audit rows and
rate limiting; membership + invite accept; api-key auth path; the cross-tenant isolation
matrix (§5); workspace header switching; 401/403 problems. E2E: existing suites run
authenticated; one new test: two users, parallel workflows, complete isolation of
lists + executions. Coverage thresholds unchanged.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Missed tenant filter in a repo → IDOR | Isolation test matrix + repo signatures make workspaceId non-optional at compile time |
| In-memory rate limiter resets on restart | Acceptable Phase 1; Redis-backed later |
| Broad test refactor churn | Single authedInject/api() helper funnel keeps the diff mechanical |
| Session theft | 30-day expiry, revocation endpoints, hash-at-rest, bearer-only until UI cookie work |
