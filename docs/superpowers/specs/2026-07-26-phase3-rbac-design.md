# Phase 3 Sub-project M — Team RBAC & Granular Permissions — Design

**Status:** Approved (design gate 2026-07-26). First Phase 3 slice.
**Requirements:** PRD WS-002 (roles Owner, Admin, Builder, Operator, Viewer, Billing), WS-006 (granular permission — custom user-defined roles deferred), SEC-004 (credential sharing based on role), API-001 (API key scoped and revocable).
**Out of scope (later slices):** user-defined custom roles and a role-editor UI (WS-006's full form); per-connection / per-workflow ACLs (SEC-004's finest grain); project-level scoping.

## Goal

Replace the linear role ladder with a capability model so the two PRD roles that are not points on a line — **Operator** (runtime rights without authoring) and **Billing** (billing/usage rights without either) — become expressible, and so every route states the permission it needs rather than a rank.

## Problem with the current model

`apps/api/src/auth/plugin.ts` ranks roles `ROLE_ORDER = { viewer: 0, builder: 1, admin: 2, owner: 3 }` and every gate asks "rank ≥ N" via `roleGate(reply, ctx, 'builder')`. An Operator must be able to cancel an execution (a builder-gated action today) but must **not** be able to edit a draft (also builder-gated) — one rank cannot satisfy both. Billing is orthogonal to the whole line. Any rank-based fix degenerates into special cases.

## Architecture

**A static permission catalog plus a role→permissions map, enforced by `requirePermission`.** Permissions are `resource:action` strings; each built-in role owns a fixed `Set<Permission>`; routes declare the permission they need. `roleGate`/`requireRole` are **removed** (not deprecated) so no call site can keep ranking silently. The map is a plain data structure, so WS-006's future `role_permissions` table can replace its source without touching a single route.

Rejected: keeping the ladder and special-casing Operator/Billing (re-breaks on the next role); shipping DB-backed custom roles now (priority S; doubles the slice and adds an admin surface nobody has asked for).

## Components

### packages/db

- **`Role`** widens to `'viewer' | 'builder' | 'operator' | 'billing' | 'admin' | 'owner'` (`repos/auth.ts`).
- **Migration `0009_rbac.sql`:**
  ```sql
  ALTER TABLE workspace_members
    ADD CONSTRAINT workspace_members_role_check
    CHECK (role IN ('viewer','builder','operator','billing','admin','owner'));

  ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'builder';
  ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_role_check
    CHECK (role IN ('viewer','builder','operator','billing','admin','owner'));
  ```
- **`repos/auth.ts`:** `createApiKey` accepts `role?: Role` (default `'builder'`), `getActiveApiKey` returns `{ workspaceId, role }`, and `listApiKeys` includes the role; new `listMembers(db, workspaceId): Promise<{ userId; email; role; createdAt }[]>` and `updateMemberRole(pool, { workspaceId, userId, role }): Promise<'ok' | 'not_member' | 'last_owner'>` — the owner count is checked inside the same transaction as the update (`SELECT … FOR UPDATE`), so two concurrent demotions cannot both pass the guard. The route maps the three results to 200 / 404 / 409.

### apps/api/src/auth/permissions.ts (new)

```ts
export type Permission =
  | 'workflow:read' | 'workflow:write' | 'workflow:activate'
  | 'execution:read' | 'execution:run' | 'execution:cancel' | 'approval:decide'
  | 'connection:read' | 'connection:write'
  | 'alert:read' | 'alert:write'
  | 'usage:read'
  | 'billing:read' | 'billing:manage'
  | 'member:manage';

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>>;
export function hasPermission(role: Role, permission: Permission): boolean;
```

Role → permissions (the authoritative table; the unit test asserts exactly this):

| Permission | owner | admin | builder | operator | billing | viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `workflow:read` | ✔ | ✔ | ✔ | ✔ | – | ✔ |
| `workflow:write` | ✔ | ✔ | ✔ | – | – | – |
| `workflow:activate` | ✔ | ✔ | ✔ | – | – | – |
| `execution:read` | ✔ | ✔ | ✔ | ✔ | – | ✔ |
| `execution:run` | ✔ | ✔ | ✔ | ✔ | – | – |
| `execution:cancel` | ✔ | ✔ | ✔ | ✔ | – | – |
| `approval:decide` | ✔ | ✔ | ✔ | ✔ | – | – |
| `connection:read` | ✔ | ✔ | ✔ | – | – | – |
| `connection:write` | ✔ | ✔ | ✔ | – | – | – |
| `alert:read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `alert:write` | ✔ | ✔ | ✔ | ✔ | – | – |
| `usage:read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `billing:read` | ✔ | ✔ | – | – | ✔ | – |
| `billing:manage` | ✔ | ✔ | – | – | ✔ | – |
| `member:manage` | ✔ | ✔ | – | – | – | – |

`connection:read`/`:write` being builder-and-above is SEC-004's role-based credential sharing in its first honest form: an Operator can run a workflow that *uses* a connection (the worker resolves it server-side) but can never list or read connection metadata.

`billing:*` has no consumer yet — Sub-project N (plans/entitlements) is its first caller. It is defined here so N does not have to reopen the catalog.

### apps/api/src/auth/plugin.ts

- Remove `ROLE_ORDER`, `requireRole`, `roleGate`.
- Add `requirePermission(reply: FastifyReply, ctx: AuthContext, permission: Permission): boolean` — returns true, or sends `403 Forbidden` with detail `Requires the '<permission>' permission` and returns false.
- Fail-closed: a role string not present in `ROLE_PERMISSIONS` yields no permissions (never throws). The CHECK constraint makes this unreachable in practice; the code does not rely on that.
- API-key auth sets `role: key.role` instead of the hardcoded `'builder'`.

### Route migration (all 25 call sites)

| Route (all 25 currently-gated call sites) | Permission |
|---|---|
| `POST /v1/workflows`, `PUT …/draft`, `POST …/publish`, `POST …/versions/:versionId/rollback`, `PUT …/callback`, `DELETE …/callback`, `POST /v1/templates/:id/clone`, `POST /v1/ai/generate`, `POST /v1/ai/edit` | `workflow:write` |
| `POST /v1/workflows/:id/activate`, `POST …/deactivate` | `workflow:activate` |
| `POST /v1/workflows/:id/execute`, `POST /v1/executions/:id/retry` | `execution:run` |
| `POST /v1/executions/:id/cancel` | `execution:cancel` |
| `POST /v1/executions/:id/approvals/:nodeId` | `approval:decide` |
| `POST /v1/connections`, `DELETE …`, `POST …/test` | `connection:write` |
| `GET /v1/connections` | `connection:read` |
| `POST /v1/alerts`, `PUT`, `DELETE`, `POST …/events/:id/ack` | `alert:write` |
| `POST /v1/workspaces/invites`, `POST/GET/DELETE /v1/api-keys`, member routes | `member:manage` |

Read routes that are currently ungated (`GET /v1/workflows`, `GET /v1/workflows/:id`, `POST …/validate`, `GET /v1/executions`, `/v1/usage`, `/v1/alerts`, `/v1/templates`, `/v1/connectors`) **stay ungated** for any authenticated member — every role in the table holds the corresponding `*:read`, so gating them would change nothing except for `billing`, and locking a billing user out of read-only inspection is not a goal of this slice.

**One deliberate behavior change:** `GET /v1/connections` gains an explicit `connection:read` gate, so viewers, operators, and billing users lose connection listing. That is precisely SEC-004 (credential sharing based on role) in its first form, and it is the only route whose effective access narrows for an existing role.

### Member management (`routes/workspaces.ts`)

- `GET /v1/workspaces/members` (`member:manage`) → `{ items: [{ userId, email, role, createdAt }] }`.
- `PUT /v1/workspaces/members/:userId` (`member:manage`) body `{ role }` (zod enum of the six) →
  - 404 if the user is not a member of this workspace;
  - **409 `last_owner`** if the change would leave the workspace with zero owners (`countOwners` ≤ 1 and the target is the last owner being demoted);
  - **403** if the caller is not an `owner` and is trying to grant `owner` (only an owner may mint another owner);
  - else 200 with the updated member.
- Invite body role enum widens from `['viewer','builder','admin']` to all six.
- `POST /v1/api-keys` body gains optional `role` (zod enum, default `'builder'`); a non-owner cannot mint an `owner` key (same rule as members).

### apps/web

- **Members page** (`/members`, linked in nav): lists members with their role and a role `<select>` that calls `updateMemberRole`; shows the 409/403 problem detail inline. Invite form gains the new roles.
- `lib/api.ts`: `listMembers()`, `updateMemberRole(userId, role)`; the API-key create form gains a role select.
- The nav/pages a role cannot use are **not** hidden this slice (the API is the enforcement boundary); hiding is cosmetic and deferred.

## Data flow

```
request → auth plugin resolves { userId, workspaceId, role }   (session membership or api_keys.role)
        → route calls requirePermission(reply, ctx, 'workflow:write')
        → hasPermission(role, permission) via ROLE_PERMISSIONS
        → 403 problem naming the permission, or the handler runs
```

## Error handling

- 403 names the missing **permission**, not a role, so the message stays true as the role map evolves.
- Unknown/legacy role → empty permission set (fail closed).
- Last-owner protection is enforced in the route inside a single statement path; a concurrent double-demote is prevented because `updateMemberRole` re-checks owner count in the same transaction.
- Existing rows are all `viewer|builder|admin|owner`, so the new CHECK constraint applies cleanly with no data migration.

## Testing

- **permissions unit:** `ROLE_PERMISSIONS` matches the table above exactly (a literal fixture, not derived from the implementation); every `Permission` in the catalog is granted to at least one role; `hasPermission` is false for an unknown role.
- **api permission matrix:** for each of the six roles, call one representative route per permission and assert 200/201/204 vs 403 — the regression net for gate drift. Includes: operator can `cancel`/`approve` but gets 403 on `PUT …/draft`; billing can `GET /v1/usage` but 403 on `GET /v1/connections`; viewer 403 on `execution:run`.
- **api member management:** list members; change a role; 409 demoting the last owner; 403 when a non-owner grants owner; 404 for a non-member.
- **api key roles:** a key issued with `role: 'viewer'` gets 403 on `POST /v1/workflows` and 200 on `GET /v1/workflows`; default stays `builder`.
- **web:** client method matrix; members page role-change mapping.
- **e2e:** owner invites an operator → the operator accepts → the operator executes a published workflow (202/201) but is refused a draft edit (403).

Gates before merge: all package suites green, coverage ≥80% every metric per package, root `typecheck` clean, `@xperiment/e2e` + `@xperiment/web e2e` green, then adversarial multi-agent review, fix confirmed findings, fast-forward merge `feature/phase3-rbac` → master.

## File layout

```
packages/db/src/migrations/0009_rbac.sql        (new)
packages/db/src/repos/auth.ts                    (Role union, api-key role, member queries)
packages/db/test/auth.test.ts                    (member/role queries)
apps/api/src/auth/permissions.ts                 (new: catalog + role map + hasPermission)
apps/api/src/auth/plugin.ts                      (requirePermission; drop roleGate; key role)
apps/api/src/routes/*.ts                         (25 call sites migrated + 2 new gates)
apps/api/test/permissions.test.ts                (new: catalog unit)
apps/api/test/rbac.test.ts                       (new: permission matrix + members + key roles)
apps/web/src/app/(app)/members/page.tsx          (new)
apps/web/src/lib/api.ts                          (members client + types)
apps/web/src/components/shell/Sidebar.tsx        (Members nav)
apps/web/test/api.test.ts                        (matrix)
e2e/test/acceptance.test.ts                      (operator flow)
README.md                                        (RBAC section)
```
