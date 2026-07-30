# PRD Phase 4 — Decomposition & Roadmap

**Status:** Scope approved 2026-07-30. Order: **P → 4A → 4B → 4C**, then re-evaluate.
**Method:** five parallel readers mapped each capability against the merged codebase; the combined
critique below is the author's, after the automated critique agent failed twice on prompt size.

Phase 4 in the PRD is one line per capability (lines 1120–1129). Mapped against the code it is
**≈35 independently shippable slices** — roughly four times Phase 3. It is not a phase to run to
completion; it is a menu.

## The three findings that shaped the order

### 1. Phase 3P is a hard prerequisite, found independently three times

| Reader | Why P blocks it |
|---|---|
| networking | The private-network agent needs per-tenant decryption. Today **one global key** (`packages/db/src/crypto.ts:6`) decrypts every tenant's credentials, so a customer-premise process cannot be given decryption capability safely. |
| environments | Environment-scoping rewrites `connections.encrypted_payload` (`0003_connections.sql:6`) — the same table and column SEC-001 re-keys. |
| variables | A secret variable is a second credential store, inheriting SEC-001 by construction. |

Skipping P means migrating and re-testing the credential vault twice.

### 2. `connectionRef` is the hidden coupling

`connectionRef` is a bare UUID in the published IR (`packages/ir/src/schema.ts:30`), and the worker
resolves it with **no workspace or environment filter** — `apps/worker/src/runTask.ts:56` omits the
optional `workspaceId` of `getConnectionWithPayload` (`packages/db/src/repos/connections.ts:42-53`).

The same line is:

- the highest risk in **environments** — promoting a dev-published version to prod runs prod traffic
  on the dev credential, or worse the reverse: a dev test firing real WhatsApp messages or real
  email through the production credential;
- the indirection **embedded** needs for EMB-006 isolation;
- the column **P/SEC-001** re-keys.

Whichever lands first must introduce the indirection. The missing workspace filter is independently
worth fixing and is tracked as its own task (defense-in-depth: publish-time validation is the only
guard today).

### 3. The most expensive schema decision is the second tenancy axis

Environments and embedded end-customers ask the same question — *is the new axis a workspace, or a
new entity?* Every table is keyed on `workspace_id`. Answering it differently for the two features
produces two incompatible axes.

A concrete structural blocker already exists: `workflow_triggers UNIQUE (workflow_id, node_id)`
(`0002_triggers.sql:19`) makes it impossible for one workflow to hold both a dev and a prod webhook
URL for the same trigger node, and `route_key TEXT NOT NULL UNIQUE` compounds it.

## Slices

### Prerequisite — Phase 3P (next up)

Security hardening: SEC-001 envelope encryption / KMS, SEC-009 credential audit. **SEC-009 is not a
separate project from 4A** — it is a set of emission call sites inside 4A's audit table. Whichever of
P or 4A lands first owns the schema; the other consumes it. Since P runs first, P owns it.

### Wave 1 — buildable without the tenancy-axis decision

| Slice | Content | PRD | Depends on |
|---|---|---|---|
| **4A** | Audit spine + workspace audit log | AUTH-007 remainder, SEC-009 | P (schema owner) |
| **4B** | Session assurance + MFA TOTP | AUTH-004 | 4A |
| **4C** | SSO SAML/OIDC | AUTH-005 | 4A, 4B |
| **4F** | Audit export | MON-007 | 4A |

**Why 4A first.** `auth_events` (`0004_auth.sql:50-57`) exists with five write sites in
`apps/api/src/routes/auth.ts`, so login/logout/failed-login is genuinely done. But it has **no
`workspace_id`**, no actor/target split, no metadata, no read path — and **zero privilege changes are
logged**: not `updateMemberRole`, not api-key create or revoke, not invite create or accept, not the
plan change in `routes/plan.ts`. SSO, MFA and SCIM all need somewhere to write events; building them
first means retrofitting audit into three new subsystems.

**Why 4B before 4C.** Both widen the same `sessions` table and the same `AuthContext`
(`apps/api/src/auth/plugin.ts:7-11`, currently `{ userId, workspaceId, role }` with no notion of how
strongly the caller authenticated). Split, that alteration happens twice.

### Wave 2 — after P and the tenancy-axis decision

| Slice | Content | PRD | Notes |
|---|---|---|---|
| **4D** | Environments + variables | WS-007, WS-008 | Heaviest slice in the phase: tenancy axis, the `workflow_triggers` UNIQUE, and the `connectionRef` indirection at once |
| **4E** | Retention + audit legal hold | EXE-013 | Shares one deletion path with Phase 3Q/WS-010 — see the FK blockers below |
| **4G** | Embedded foundation: end-customer model, embed token, connector allowlist | EMB-001, EMB-005, EMB-006, EMB-007 | Gated on the legal questions below |
| **4H** | Embedded surfaces: end-user connection creation, template configuration | EMB-002, EMB-003 | Needs 4G |

**Retention has two blocking FKs.** `execution_waits.execution_id` (`0005_waits.sql:4`) has no
`ON DELETE`, so `DELETE FROM executions` raises 23503 for every execution that ever suspended — i.e.
it fails on exactly the workspaces using the 2F wait/approval feature most. And
`executions.trigger_event_id` (`0001_init.sql:58`) points child→parent with no `ON DELETE`, so
`trigger_events` (holding the raw inbound payload) survive their executions and are unreachable by
any purge starting from `executions`. A sweep written without a migration cannot run.

**Retention must not reach `usage_events`.** That ledger is the billing source of truth
(`packages/db/src/repos/usage.ts`, and `recomputeCounters` rebuilds counters from it), so purging it
makes issued invoices unreissuable and undefendable.

### Deferred, with reasons

| Item | PRD priority | Why deferred |
|---|---|---|
| SCIM (AUTH-006) | **C** | Pointless without SSO — you would provision accounts that then log in with passwords. Also needs an Okta/Entra gallery listing, which is a submission-and-review process. |
| Embed branding (EMB-004) | **C** | Needs an embed surface to theme. |
| Visual embedded builder (EMB-010) | **C** | PRD itself says "setelah core stabil". Superset of 4G + 4H. |
| Private networking / agent | — | No requirement ID; PRD open question 12 still asks whether the agent is needed for the first enterprise customer. Hard-blocked on P. |
| Regional / private deployment | — | The repo has **no Dockerfile, no CI, no IaC** — there is no deployment substrate to regionalise. Also needs shared-store rate limiting (`apps/api/src/rateLimit/plugin.ts` is in-memory) and a migration advisory lock before any multi-instance deployment is correct. |
| Enterprise SLA | — | Mostly a legal and commercial document. Its engineering half is the public status page, which is Phase 3U. |

## Decisions this roadmap does not make

**Legal.** Two questions require counsel, not engineering judgement, and the design of 4G depends on
both:

- **UU PDP 27/2022** — who is data controller versus processor for end-customer credentials and
  message content? The answer determines whether workspace-per-end-customer is even sufficient.
- **Meta BSP / tech-provider terms** — the 2L WhatsApp pack was built for a workspace owning its own
  WABA. A partner creating WhatsApp connections *on behalf of* its end customers is a different
  arrangement governed by Meta, not by us.

**Compliance framing.** If SOC 2 or ISO 27001 is the real driver behind AUTH-007, the auditor — not
engineering — sets immutability, retention duration and export format. "Append-only and provably
untampered" is a substantially larger build than "a table admins can read", and that distinction
should be settled before 4A chooses its schema.

**Multi-instance correctness.** Nothing in Wave 1 or 2 requires it, but regional deployment and the
SLA both do, and two known single-instance assumptions would have to be fixed first (in-memory rate
limiter, unlocked migration runner).
