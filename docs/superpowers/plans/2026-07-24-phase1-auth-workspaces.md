# Phase 1 Sub-project C: Auth + Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email/password auth with revocable sessions, multi-workspace with 4 roles + API keys, and enforced tenant scoping across every control-plane route, proven by a cross-tenant isolation test matrix.

**Architecture:** Spec `docs/superpowers/specs/2026-07-24-phase1-auth-workspaces-design.md`. Zero new dependencies (Node scrypt/sha256). Data plane untouched except repo signatures.

**Tech Stack:** existing.

## Global Constraints

- All prior constraints. Token prefixes exact: sessions `qs_`, api keys `qk_`. Password hash format `saltHex:hashHex` (scrypt N default, keylen 32, salt 16B). Session TTL 30 days; invite TTL 7 days. Role order `viewer < builder < admin < owner`. Rate limit: 5 login attempts / 60 s per email+ip, 6th → 429. Workspace header: `X-Xperiment-Workspace`.
- Auth-exempt routes (exact): `/v1/healthz`, `POST /v1/auth/register`, `POST /v1/auth/login`. (`/v1/invites/accept` requires auth.)
- API keys authenticate with role `builder`, `userId: null`.
- After this slice `DEFAULT_WORKSPACE_ID` appears only in the migration seed and test helpers — never in runtime code paths.

## File Structure

```text
packages/db/src/authCrypto.ts               # scrypt hash/verify, token gen/hash
packages/db/src/migrations/0004_auth.sql
packages/db/src/repos/auth.ts               # users, sessions, members, invites, api keys, auth events
apps/api/src/auth/plugin.ts                 # preHandler, AuthContext, role gate
apps/api/src/auth/rateLimit.ts              # fixed-window in-memory limiter
apps/api/src/routes/auth.ts                 # register/login/logout(-all)/me
apps/api/src/routes/workspaces.ts           # workspaces, invites, api-keys
apps/api/test/authHelpers.ts                # register+login+authedInject
apps/api/test/isolation.test.ts             # cross-tenant matrix
apps/cli/src/auth.ts                        # token store (~/.xperiment/credentials.json)
e2e/test/isolation.test.ts                  # two-user e2e
```

---

### Task 1: DB — authCrypto, migration 0004, auth repos (TDD)

**Produces:** `hashPassword(pw): Promise<string>`, `verifyPassword(pw, stored): Promise<boolean>`, `generateToken(prefix: 'qs'|'qk'): { token: string; hash: string }` (hash = sha256 hex), `hashToken(token): string`. Repos in `repos/auth.ts`: `createUser({email, passwordHash})` (23505 → null), `getUserByEmail`, `createSession({userId, tokenHash, expiresAt})`, `getActiveSession(tokenHash)` (joins user; null if expired/revoked), `revokeSession(tokenHash)`, `revokeAllSessions(userId)`, `createWorkspaceWithOwner({name, userId})` (tx: workspace + owner membership), `listMemberships(userId): {workspaceId, name, role}[]`, `getMembership(workspaceId, userId)`, `addMember`, `createInvite({workspaceId, tokenHash, role, expiresAt})`, `acceptInvite(tokenHash, userId)` (null if expired/used; adds membership, sets accepted_by), `createApiKey({workspaceId, name, keyHash})`, `getActiveApiKey(keyHash)` (updates last_used_at), `listApiKeys(workspaceId)`, `revokeApiKey(id, workspaceId)`, `appendAuthEvent({userId?, email?, eventType, ip?})`.
**Tests:** crypto round-trip + wrong password + tamper; token format/prefix; every repo happy path + duplicate email + expired session + expired/used invite + revoked key; workspaceWithOwner atomicity.
**Commit:** `feat: auth crypto, schema, and repositories`

### Task 2: Tenant-scoped repositories (TDD refactor)

**Changes (exact signatures):**
- `createWorkflow(db, { workspaceId, name })`; `getWorkflow(db, id, workspaceId?)` (filters when given); `listWorkflows(db, { workspaceId, limit, cursor })`.
- `createConnection(db, { workspaceId, ... })`; `listConnections(db, workspaceId)`; `getConnectionWithPayload(db, id, workspaceId?)`; `deleteConnection(db, id, workspaceId)`; `countPublishedRefs` unchanged.
- `listExecutions(db, { workspaceId?, workflowId?, limit, cursor })`; `getExecutionDetail(pool, id, workspaceId?)`.
- `listTriggers(db, workflowId)` unchanged (guard at route via workflow lookup); `recentTestTriggerPayloads` unchanged (same guard).
- Writes inherit workspace from the workflow row: `workflow_drafts` insert, `createVersion`, `upsertTrigger`, `createExecutionWithTrigger` (+ its node/event/outbox inserts) use `(SELECT workspace_id FROM workflows WHERE id = $n)`; `createSession`-style direct params removed from those SQL texts. `DEFAULT_WORKSPACE_ID` exports remain but runtime call sites go through the new params.
- Data-plane callers (gateway/scheduler/worker/orchestrator) compile unchanged except added `undefined` workspace args where optional.
**Tests:** update existing db tests to pass workspaceId (use `DEFAULT_WORKSPACE_ID`); new: rows created under workspace A invisible to `list*(workspaceB)` and `get*(id, workspaceB)` → null.
**Commit:** `refactor: workspace-scoped repositories with inherited data-plane tenancy`

### Task 3: API — auth plugin, rate limiter, auth/workspace routes (TDD)

**Produces:** `plugin.ts`: `interface AuthContext { userId: string | null; workspaceId: string; role: 'viewer'|'builder'|'admin'|'owner' }`; fastify decorator `request.authContext`; preHandler resolving qs_/qk_ bearers per spec §4; `requireRole(ctx, min): boolean` + `roleGate(reply, ctx, min)` sending 403. `rateLimit.ts`: `loginLimiter.check(key): boolean` fixed 60s window of 5. Routes per spec §6 with auth_events writes.
**Tests (inject):** register → 201 + token works on /me; duplicate register 409; login ok/bad (generic 401), 6th rapid failure 429; logout kills session; logout-all kills both sessions; /me lists memberships; workspace create + switch via header; invite create (admin) → accept by second user → membership role honored; viewer role forbidden from POST /v1/workflows (403); api-key create shown once, authenticates, revoked key 401; missing/garbage bearer 401.
**Commit:** `feat: session auth, roles, workspaces, invites, api keys`

### Task 4: API — scope every existing route + isolation matrix (TDD)

**Changes:** all existing routes read `request.authContext` and pass `workspaceId` into repos; triggers/samples routes guard via `getWorkflow(id, workspaceId)` first; connections routes scope; role minimums per spec §4 applied (writes → builder). `apps/api/test/authHelpers.ts`: `createAuthedUser(app): Promise<{ token; workspaceId; inject }>` where `inject` wraps `app.inject` adding the bearer; refit ALL existing api tests through it (mechanical).
**New `isolation.test.ts` matrix:** two users A/B: B cannot `GET/PUT draft/publish/execute/activate` A's workflow (404), cannot see A's workflows/connections/executions in lists (empty), cannot read A's execution detail or trigger samples (404), cannot delete A's connection (404); A's api key cannot read B's data; B's viewer-role member cannot write in A's workspace they were never invited to (403/404).
**Commit:** `feat: tenant-scoped API with cross-tenant isolation test matrix`

### Task 5: CLI login + e2e refit + two-user e2e (TDD where applicable)

- `apps/cli/src/auth.ts`: `saveToken(token)`, `loadToken(): string | null` (`~/.xperiment/credentials.json`, mode 0600, `XPERIMENT_TOKEN` env wins); `ApiClient` sends `Authorization` when a token exists; new commands `xperiment login --email --password`, `xperiment logout`; client tests updated to register/login through the real API first.
- `e2e/test/helpers.ts`: `prepareDatabase()` also registers `e2e@xperiment.test` / logs in via direct repo+crypto calls? No — via HTTP after services boot is impossible (DB prepared pre-boot). Instead: export `authToken` set lazily — add `ensureAuth()` called by `api()` on first use: register (idempotent: on 409 → login) against the live API, cache token, attach bearer. All e2e suites then pass unchanged.
- New `e2e/test/isolation.test.ts`: two registered users; each creates+publishes+executes a manual workflow via API; each sees exactly 1 workflow and their own executions; cross GET of the other's workflow → 404.
**Commit:** `feat: cli login and authenticated e2e with two-user isolation`

### Task 6: Full verification + docs

- `.env.example` unchanged (no new envs). README: Authentication section (register/login, bearer usage, `X-Xperiment-Workspace`, api keys, CLI login).
- `pnpm typecheck`, `pnpm test`, `pnpm run test:cov` (≥80% everywhere), `pnpm --filter @xperiment/e2e test` all green.
**Commit:** `feat: auth docs and verification`

## Final Verification

- [ ] Full suites green with coverage; e2e (5 files) green
- [ ] Grep: no `DEFAULT_WORKSPACE_ID` in `apps/**/src` or repo runtime SQL paths
