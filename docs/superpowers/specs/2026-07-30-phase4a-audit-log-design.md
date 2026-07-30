# Phase 4A — Workspace Audit Log

**Status:** design approved 2026-07-30.
**Covers:** AUTH-007 remainder — privilege-change emission and the workspace audit log UI.
**Builds on:** Phase 3P (`82d6653`..`fabac00`), which shipped the audit spine.

---

## 1. What P already delivered

4A does **not** design an audit schema. P owns it, and 4A extends it:

- `audit_events` with a nullable `workspace_id`, an actor/target split, `outcome`,
  scalars-only `metadata` JSONB, `request_id`/`ip`/`user_agent`, and indexes on
  `(workspace_id, id DESC)` and `(workspace_id, target_type, target_id, id DESC)`.
- `appendAuditEvent(db: Db, input)` — a pool or a transaction client both satisfy `Db`, so
  the call site decides transactionality.
- `listAuditEvents` — keyset-paginated on `id DESC`, never returns `workspace_id IS NULL`.
- The `audit:read` permission on **admin and owner only**, and `GET /v1/audit`.
- `auditActor(req)` in `apps/api/src/auth/plugin.ts`.
- Emitting already: five `auth.*` events, `credential.create` / `.delete` / `.test` /
  `.read_use`, `trigger_secret.reveal`, `secret.rekey_batch`.

**Zero privilege changes are logged.** That is what 4A fixes, plus the read surface for it.

## 2. The problem: three sites cannot be wrapped by their route

Reading the code rather than the decomposition, the nine sites split two ways.

**Three repo functions own their own transaction and take a `pg.Pool`, not a `Db`:**

| Function | Why it owns the transaction |
|---|---|
| `updateMemberRole` (`repos/auth.ts:285`) | `pg_advisory_xact_lock` + `FOR UPDATE` + the last-owner guard |
| `acceptInvite` (`repos/auth.ts:156`) | `FOR UPDATE` on the invite + advisory lock + the seat check |
| `createWorkspaceWithOwner` (`repos/auth.ts:74`) | inserts the workspace and its owner membership together |

A route cannot pass these a client. And loosening them to accept a `Db` would be actively
dangerous: `pg_advisory_xact_lock` releases at transaction end, so a caller who passed a
pool would acquire and instantly release it per statement, and the last-owner guard M
exists to provide would **silently stop working**. That is not a trade worth making for
symmetry.

**The other six are plain `Db` queries** — `createInvite`, `createApiKey`, `revokeApiKey`,
`setWorkspacePlan`, `setInvoiceProvider`, `markInvoicePaid` — so route-level `withTx`
works there, exactly as P's connection routes do.

### Decision

The three lock-owning functions take `actor: AuditActor` as a field of their existing args
object — `createWorkspaceWithOwner` grows an args field too — and emit on their own
transaction client. Atomicity stays where it is already guaranteed, and no caller can
defeat the lock. The other six emit from a route-level `withTx`.

## 3. `AuditActor`

`auditActor(req)` already returns precisely the field names `AuditEventInput` accepts. That
shape becomes a named type exported from `@xperiment/db`, so the helper produces it and the
repos consume it with no duplicated literal:

```ts
export interface AuditActor {
  actorKind: ActorKind;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}
```

`auditActor(req): AuditActor` — the return type is annotated rather than inferred, so a
drift between the helper and the interface is a compile error.

## 4. Three return types widen

Each of these already holds — or trivially can hold — the audit-critical fact, and
currently throws it away.

`updateMemberRole` reads the previous role into `was` at `repos/auth.ts:296` purely to run
the last-owner check, then returns a bare string union. "Was viewer, now admin" is the
entire value of a privilege-change record:

```ts
export type UpdateMemberRoleResult =
  | { outcome: 'ok'; previousRole: Role }
  | { outcome: 'not_member' }
  | { outcome: 'last_owner' };
```

Moving off the string union to a discriminated union matches N's `CreateExecutionResult`.
Every caller must be updated — the api route and the db tests.

`acceptInvite` has `row.role` in hand and returns only `{ outcome, workspaceId }`:

```ts
export type AcceptInviteResult =
  | { outcome: 'joined'; workspaceId: string; inviteId: string; role: Role; alreadyMember: boolean }
  | { outcome: 'invalid' }
  | { outcome: 'quota_exceeded'; used: number; limit: number };
```

`alreadyMember` is not cosmetic. The membership insert is `ON CONFLICT DO NOTHING`, so a
re-join grants nothing and changes no role; an audit row claiming a grant would be false.

`createInvite` returns `void` today, and `acceptInvite`'s `FOR UPDATE` select fetches only
`workspace_id, role`. `workspace_invites` does have an `id UUID PRIMARY KEY`, so both grow
it — `createInvite` via `RETURNING id`, `acceptInvite` by selecting it:

```ts
export async function createInvite(db: Db, args: { … }): Promise<{ id: string }>;
```

Without this, both invite actions would have a null `target_id` and the
`(workspace_id, target_type, target_id)` index could not answer "everything about this
invite". Logging the `token_hash` as an identifier instead is not an option.

`createWorkspaceWithOwner` already returns `{ id, name }`, which is enough.

## 5. Action catalog — nine actions

`noun.verb`, imperative, matching the existing majority (`credential.create`,
`credential.delete`) rather than the past-tense `auth.login_succeeded` minority.

| Action | Site | target_type | metadata |
|---|---|---|---|
| `member.role_change` | `PUT /v1/workspaces/members/:userId` | `user` | `previousRole`, `newRole` |
| `api_key.create` | `POST /v1/api-keys` | `api_key` | `name`, `role` |
| `api_key.revoke` | `DELETE /v1/api-keys/:id` | `api_key` | — |
| `invite.create` | `POST /v1/workspaces/invites` | `invite` | `role`, `expiresAt` |
| `invite.accept` | `POST /v1/invites/accept` | `invite` | `role`, `alreadyMember` |

| `plan.change` | `PUT /v1/plan` | `workspace` | `previousPlan`, `newPlan`, `allowOverage` |
| `invoice.pay` | `POST /v1/invoices/:id/pay` | `invoice` | `totalMinor`, `currency`, `provider` |
| `invoice.mark_paid` | `POST /v1/invoices/:id/mark-paid` | `invoice` | `totalMinor`, `currency` |
| `workspace.create` | `POST /v1/workspaces` | `workspace` | `name` |

**No token or hash reaches metadata** — not the invite token, not the api key, not either
`*_hash`. `AuditMetadata` being scalars-only stops an object spread, but a string token
would typecheck, so this is a review point rather than a type guarantee.

Both invite actions target the `workspace_invites.id` surfaced by §4, so an auditor can
follow one invite from creation to acceptance. The accepting user is the actor on
`invite.accept`, so their id is not repeated in metadata.

**`plan.change` needs the previous plan**, which `setWorkspacePlan` does not return. The
route reads `getWorkspacePlan` inside the same transaction as the write and the emission —
both take a `Db`, so this composes.

**`invoice.pay` audits the local record, not the charge.** The provider call happens before
any transaction, so a provider success followed by a failed local write leaves no audit
row. That is pre-existing route structure and 4A does not restructure it; the limitation is
recorded rather than papered over.

## 6. The read path resolves actors

Today a UI over `GET /v1/audit` renders `actor_user_id: 3e5b32a0-…`. `listAuditEvents`
gains two projected columns:

```ts
actorEmail: string | null;       // LEFT JOIN users
actorApiKeyName: string | null;  // LEFT JOIN api_keys
```

`actorLabel` remains the fallback when the user row is gone — which is what that column
already exists for, and why resolving on read rather than denormalising on write is the
cheaper choice: no per-request lookup, and no need to widen `AuthContext` with an email.

**The api-key join is keyed on id *and* `workspace_id`**, not id alone, so the projection
cannot surface another tenant's key name even if an `actor_api_key_id` ever pointed across
workspaces. The raw ids stay in the response alongside the resolved names.

## 7. The web page

`apps/web/src/app/(app)/audit/page.tsx`, plus a sidebar entry after Members. It follows the
Members page pattern exactly — TanStack Query, `getBrowserClient()`, and
`forbiddenDetail` + `PermissionNotice` for the 403 that viewer, operator, builder and
billing all receive.

Columns: time, actor, action, target, outcome. An action filter dropdown over a
known-actions constant. A "Load more" button driving the `nextBefore` cursor the endpoint
already returns.

**One characteristic accepted rather than designed away:** `credential.read_use` emits one
row per node per execution, so on a busy workspace the unfiltered list is mostly worker
noise. The filter handles it. The default view is deliberately **not** pre-filtered — a
default that silently omits rows is the wrong instinct for an audit log.

## 8. Testing

Per action, a pair: exactly one row on success, and **zero** on each refusal path —
403 owner-grant, 404 not-member / unknown invoice, 409 last-owner and already-settled, 402
seat quota, 400 invalid body.

Beyond that:

- `member.role_change` records the real previous role, and a refused last-owner demotion
  emits nothing.
- `invite.accept` on an existing membership records `alreadyMember: true`.
- The three internal emissions are atomic, proven by the break-it check P established:
  force a failure after the mutation and confirm the row is absent, then confirm the same
  injection with a pool-based emission leaves it behind.
- No response token appears in any audit row — asserted against the actual returned token,
  for the invite and api-key routes.
- `actorEmail` resolves for a session actor and `actorApiKeyName` for an api-key actor;
  after the user row is deleted, `actorEmail` is null and `actorLabel` survives.
- Cross-workspace rows stay invisible, and the api-key name of another workspace is
  unreachable.
- Playwright: an admin sees the page with rows; a viewer sees the permission notice.

Coverage thresholds stay 80% on lines/statements/functions/branches per package. The full
suite runs with **`pnpm test`**, never `pnpm -r test` — the root script pins
`--workspace-concurrency=1`, and run concurrently `@xperiment/queue`'s outbox publisher races
other suites over `task_outbox`.

## 9. Out of scope

| Item | Owner |
|---|---|
| Audit export | 4F |
| Retention, legal hold | 4E |
| Immutability proofs / tamper evidence | undecided — if SOC 2 drives AUTH-007, the auditor sets this, not engineering |
| Logging authorization denials (403) | rejected: normal UI traffic calls endpoints it lacks permission for and renders `PermissionNotice`, so this would flood the table |
| MFA and SSO events | 4B and 4C, which add actions to this catalog |
| The adversarial review of Phase 3P | still owed; skipped by explicit choice, not completed |
