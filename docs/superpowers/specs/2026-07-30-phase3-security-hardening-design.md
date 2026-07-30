# Phase 3P — Security Hardening: Envelope Encryption & Audit Spine

**Status:** design approved 2026-07-30.
**Covers:** SEC-001 (credentials at rest under envelope encryption / KMS), SEC-009 (audit every
credential create / read-use / delete).
**Owns:** the `audit_events` schema. Per `docs/superpowers/specs/2026-07-30-phase4-decomposition.md`,
P runs before 4A, so P defines the audit table and 4A extends it.

---

## 1. What exists today

One global key decrypts every tenant's secrets. `packages/db/src/crypto.ts` is 24 lines:

```ts
export function deriveTriggerKey(envValue: string): Buffer {
  return createHash('sha256').update(envValue).digest();
}
```

Two derived keys, four encrypted columns, nine call sites:

| Column | Table | Key | Written at | Read at |
|---|---|---|---|---|
| `encrypted_payload` | `connections` | `CREDENTIALS_SECRET_KEY` | `routes/connections.ts:38` | `routes/connections.ts:72`, `worker/runTask.ts:61` |
| `secret_encrypted` | `workflow_triggers` | `TRIGGER_SECRET_KEY` | `routes/triggers.ts:79` | `routes/triggers.ts:43`, `gateway/server.ts:53` |
| `completion_webhook_secret_encrypted` | `workflows` | `TRIGGER_SECRET_KEY` | `routes/workflows.ts:140` | `worker/callback.ts:41` |
| `webhook_secret_encrypted` | `alert_rules` | `TRIGGER_SECRET_KEY` | `routes/alerts.ts:52` | `worker/alertDelivery.ts:52` |

Three problems, in order of severity:

1. **No tenant isolation in the key material.** Any process holding the one key reads every
   workspace's credentials. This is what makes Phase 4's private-network agent undesignable and
   WS-010 workspace deletion unable to offer crypto-shredding.
2. **`deriveTriggerKey` is not a KDF** — bare SHA-256, no salt, no work factor — and its name is
   wrong, since it also derives the credentials key.
3. **`auth_events` cannot serve as an audit table.** It has `user_id`, `email`, `event_type`, `ip`,
   `created_at` and nothing else: no `workspace_id`, no actor/target split, no metadata, no read
   path, and no index beyond the primary key. Zero privilege changes are logged.

---

## 2. Key hierarchy

GCP KMS has no `GenerateDataKey`, so a data key is generated locally and wrapped by a KMS
`encrypt` call. Three tiers:

| Tier | Material | Lives in | Cost per use |
|---|---|---|---|
| Root KEK | a GCP KMS CryptoKey | never leaves KMS | one KMS call per workspace per cache window |
| Workspace KEK | 32 random bytes, wrapped by the root KEK | `workspace_keys.wrapped_key` (ciphertext) | in-process cache |
| Secret DEK | 32 random bytes per secret, wrapped by the workspace KEK | inline in the secret's own blob | local AES-256-GCM, no network |

The middle tier is what keeps "DEK per secret" affordable. Without it, every node that resolves a
credential would make a KMS round-trip; with it, KMS is consulted once per workspace per TTL.

It also buys two things Phase 4 needs. Destroying one `workspace_keys` row makes every secret in
that workspace permanently undecryptable — crypto-shredding for WS-010. And per-tenant decryption
capability becomes expressible at all, which is the blocker the private-network reader found.

### `workspace_keys`

```sql
CREATE TABLE workspace_keys (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,          -- 'local' | 'gcp-kms'
  root_key_id  TEXT NOT NULL,          -- the provider's identity for the root key
  wrapped_key  BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at   TIMESTAMPTZ NULL
);
```

`ON DELETE CASCADE` is deliberate: deleting a workspace destroys its KEK, which is the
crypto-shredding property, not an accident to be guarded against.

`provider` and `root_key_id` are recorded so a future rotation (SEC-007) can find every KEK wrapped
by a retired root key. P does not rotate; it only makes rotation findable.

### First use is a race

Two concurrent requests for a workspace with no KEK will both generate one. The protocol is the
same three-statement shape 3N used for quota counters:

1. generate 32 bytes, wrap them, **round-trip unwrap to verify** before writing;
2. `INSERT INTO workspace_keys ... ON CONFLICT (workspace_id) DO NOTHING`;
3. `SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1` — unconditionally, and use
   **that** row.

Step 3 is not optional and not a formality. If the insert lost, the locally generated KEK must be
discarded and never used to encrypt anything, or the two requests encrypt under different keys and
one workspace ends up with two half-readable secret sets. This is the exact failure the 3N review
found in orphan adoption: a decision made before the winner is known must be re-read after.

The verify-before-insert in step 1 replaces CRC32C checksumming of the KMS request. A corrupted
wrap would otherwise surface much later as an entire workspace of undecryptable credentials; an
immediate unwrap catches it before any secret depends on it.

### Caching

`WorkspaceKeyring` holds `Map<workspaceId, { key: Buffer; expiresAt: number }>`, TTL from
`KEK_CACHE_TTL_MS` (default 300000). A hit costs nothing; a miss costs one `unwrap`.

Plaintext KEKs therefore sit in process memory for up to the TTL. That is inherent to avoiding a
KMS call per secret, and the TTL is the tuning knob between KMS load and how quickly a destroyed
key stops working.

---

## 3. `KeyProvider`

```ts
export interface KeyProvider {
  /** Identity of the root key, recorded in workspace_keys.root_key_id. */
  readonly keyId: string;
  readonly name: 'local' | 'gcp-kms';
  wrap(plaintextKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}
```

Two implementations, mirroring how 3O shipped `PaymentProvider` + `manualProvider`.

**`localKeyProvider(masterSecret: string)`** derives a 32-byte root key with `scrypt` over the
fixed salt `xperiment.kek.v1`, then wraps with local AES-256-GCM. The salt is a constant, not
configuration: the input is a high-entropy deployment secret rather than a user password, so
per-deployment salting would add a second losable secret without adding real protection. scrypt
rather than SHA-256 because dev and small deployments will use a low-entropy string, and because
`packages/db/src/authCrypto.ts` already uses scrypt — this aligns the two rather than introducing a
third convention. Derivation happens once per provider construction, not per operation.

**`gcpKmsKeyProvider({ keyName, client })`** calls `client.encrypt`/`client.decrypt` on the
CryptoKey named by `keyName`. It depends on a structural subset of `@google-cloud/kms` (5.7.0), not
the concrete class, so tests can supply a fake:

```ts
export interface KmsClientLike {
  encrypt(req: { name: string; plaintext: Buffer }): Promise<[{ ciphertext?: Uint8Array | string | null }, ...unknown[]]>;
  decrypt(req: { name: string; ciphertext: Buffer }): Promise<[{ plaintext?: Uint8Array | string | null }, ...unknown[]]>;
}
```

The tuple return shape is the real client's, kept verbatim so the fake cannot diverge from it. A
response with no `ciphertext`/`plaintext` throws rather than yielding an empty Buffer.

`deriveTriggerKey` is deleted.

### Configuration

| Env | Default | Meaning |
|---|---|---|
| `KMS_PROVIDER` | `local` | `local` or `gcp-kms` |
| `KMS_KEY_NAME` | — | required when `gcp-kms`; `projects/…/cryptoKeys/…` |
| `KEK_MASTER_KEY` | `xperiment-dev-kek-master-change-me` | local provider input |
| `KEK_CACHE_TTL_MS` | `300000` | workspace KEK cache lifetime |
| `TRIGGER_SECRET_KEY` | existing | still required until backfill completes |
| `CREDENTIALS_SECRET_KEY` | existing | still required until backfill completes |

`KMS_PROVIDER=gcp-kms` with no `KMS_KEY_NAME` throws at startup, not on first request. No cloud
credential is ever read from anywhere but the process environment.

---

## 4. `SecretVault` — what call sites actually use

Routes and workers never see a KEK or a DEK:

```ts
export interface EncryptedSecret { blob: Buffer; encVersion: number }

export interface SecretVault {
  encrypt(workspaceId: string, plaintext: string): Promise<EncryptedSecret>;
  decrypt(workspaceId: string, secret: EncryptedSecret): Promise<string>;
}
```

`EncryptedSecret` is one value carrying both halves, so a blob and its version cannot be written to
a row independently and drift apart. Three of the four columns are nullable, so their repo signatures
carry `EncryptedSecret | null`; when the blob is NULL the version column is written as `0` and never
read.

One vault per legacy key family — `createSecretVault({ keyring, legacyKey })` — because a v0 blob
must be decrypted with the key it was written under, and there were two. Both vaults share one
`WorkspaceKeyring`, so the split does not double KMS traffic. From v1 onward the distinction is
gone: every secret in a workspace is under that workspace's KEK.

### v1 blob format

```
[1]      0x01                     format marker
[2]      wrapped-DEK length, big-endian uint16
[N]      DEK wrapped by workspace KEK: iv(12) || tag(16) || ct(32)
[12]     payload IV
[16]     payload GCM tag
[rest]   payload ciphertext
```

The DEK wrap binds `workspaceId` as AES-GCM additional authenticated data. A blob lifted from
workspace A's row into workspace B's fails to decrypt rather than succeeding — a cross-tenant
defense that costs one `setAAD` call.

`enc_version` is the authority for dispatch; the marker byte is a consistency assertion. If a
backfill ever writes the blob and fails to write the version, the marker turns silent garbage into a
loud error.

Payload encryption reuses `encryptSecret`/`decryptSecret`, extended with an optional `aad`
parameter that defaults to none — so v0 blobs, which had no AAD, still decrypt unchanged.

### Why a version column and not a version byte

Existing v0 blobs begin with a random 12-byte IV. Any in-band marker would be ambiguous: roughly
1 in 256 legacy rows would have a first byte matching the new marker and be misread. So the
discriminator has to be out of band.

Four columns, four tables, all of which already carry `workspace_id` directly:

```sql
ALTER TABLE connections       ADD COLUMN enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE workflow_triggers ADD COLUMN secret_enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE workflows         ADD COLUMN completion_webhook_enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE alert_rules       ADD COLUMN webhook_secret_enc_version SMALLINT NOT NULL DEFAULT 0;
```

`DEFAULT 0` is what makes the migration safe on existing rows. New rows get `1` explicitly from the
repo function, never from a column default.

---

## 5. Backfill

A SQL migration cannot do this: the legacy keys live in the application environment, not in the
database. So old and new formats coexist, and the legacy env keys stay configured until the backfill
finishes.

`rekeyAll(deps, { batchSize })` in `@xperiment/db`, driven by a `xperiment rekey` command in `apps/cli`.
Per table: `SELECT id, workspace_id, <blob> FROM <t> WHERE <version> = 0 LIMIT $1`, then per row, in
its own transaction, decrypt under the legacy key, re-encrypt through the vault, and
`UPDATE … SET blob = $1, version = 1 WHERE id = $2 AND <version> = 0`.

The compare-and-set on `<version> = 0` gives three properties for free: interrupting the job leaves a
valid mixed state that both read paths handle, re-running is a no-op, and it is safe to run against
live traffic.

Progress is reported per table as `{ table, rekeyed, remaining }`. One `secret.rekey_batch` audit
event per run carries the totals — not one per row, which would flood the table with mechanical
noise.

---

## 6. `audit_events`

A new table, not a widening of `auth_events`. `auth_events` holds rows with no workspace at all — a
failed login for an unrecognised email — and grafting a nullable `workspace_id` onto it puts
global rows one forgotten `WHERE` away from appearing in a workspace's audit view. That is the same
cross-tenant leak class the Phase 1 isolation matrix exists to prevent. The five existing auth
writes move to the new table; `auth_events` is left in place as historical data and stops receiving
writes.

```sql
CREATE TABLE audit_events (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     UUID NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('user','api_key','system','anonymous')),
  actor_user_id    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_api_key_id UUID NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  actor_label      TEXT NULL,
  action           TEXT NOT NULL,
  target_type      TEXT NULL,
  target_id        TEXT NULL,
  outcome          TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id       TEXT NULL,
  ip               TEXT NULL,
  user_agent       TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_events_ws ON audit_events (workspace_id, id DESC);
CREATE INDEX idx_audit_events_target ON audit_events (workspace_id, target_type, target_id, id DESC);
```

Notes on the choices that are not obvious:

- **`target_id` is TEXT, not UUID.** Trigger targets are identified by IR node id, which is not a
  UUID.
- **`actor_user_id` is `ON DELETE SET NULL`**, so deleting a user does not delete the record of what
  they did; `actor_label` retains the email for that case, and for anonymous failed logins.
- **`workspace_id` is `ON DELETE CASCADE`**, which means deleting a workspace erases its audit
  trail, including the record of the deletion. This is a real limitation and a deliberate one: P has
  no retention policy, no legal hold and no export, so the alternative is orphaned rows that no
  endpoint can read. 4E (retention + legal hold) and 4F (export) are where a trail that outlives its
  workspace gets built properly.

### Emission rule

`appendAuditEvent(db: Db, args)` takes a `Db`, which both a pool and a transaction client satisfy.
The call site decides:

> **If the event describes a mutation, emit it inside that mutation's transaction. Otherwise emit on
> the pool.**

An audit row must not survive a rolled-back mutation, and must not be lost when the mutation
commits. That is the lesson from 3M's `updateMemberRole` — the guard and the thing it guards have to
share a transaction. So `POST /v1/connections` and `DELETE /v1/connections/:id` gain `withTx`
wrappers; read-use and failed logins, which mutate nothing, emit on the pool.

### Metadata is an allowlist

`metadata` is built at the call site from named scalar fields. Never a spread of a request body,
a connector payload, or a provider response — any of which may carry a secret. This is the same
constraint that already forbids logging a raw webhook body.

### Action catalog

Exactly the actions the code has today; no speculative entries.

| Action | Site | Actor | Target |
|---|---|---|---|
| `credential.create` | `POST /v1/connections` | user/api_key | `connection` |
| `credential.delete` | `DELETE /v1/connections/:id` | user/api_key | `connection` |
| `credential.test` | `POST /v1/connections/:id/test` | user/api_key | `connection` |
| `credential.read_use` | `worker/runTask.ts` connection resolution | system | `connection` |
| `trigger_secret.reveal` | `GET /v1/workflows/:id/triggers` with credentials | user/api_key | `trigger` |
| `secret.rekey_batch` | `xperiment rekey` | system | — |
| `auth.register` | `routes/auth.ts:42` | user | `user` |
| `auth.login_failed` | `routes/auth.ts:60` | anonymous | `user` |
| `auth.login_succeeded` | `routes/auth.ts:66` | user | `user` |
| `auth.logout` | `routes/auth.ts:75` | user | `user` |
| `auth.logout_all` | `routes/auth.ts:83` | user | `user` |

There is no `credential.update`: no update route exists. `credential.test` is listed separately from
`read_use` because it is a human decrypting a credential on demand, which is a different event from
a workflow node consuming one. `trigger_secret.reveal` is audited because that endpoint genuinely
returns a plaintext signing secret to the caller — the only one that does. `POST /v1/connections/:id/test`
decrypts but returns only `{ ok }`, so CON-020 holds and nothing there needs changing beyond the
audit row.

`credential.read_use` is one row per node that resolves a credential, with
`{ executionId, nodeId, workflowId }` in metadata.

---

## 7. Read path

`GET /v1/audit`, gated on a new `audit:read` permission granted to `admin` and `owner` only. Not
builder: a builder seeing every credential use by every member is itself a privilege escalation.

Query: `limit` (default 50, max 200), `before` (cursor), `action`, `targetType`, `targetId`.
Pagination is keyset on `id DESC`.

Ordering is on `id`, not `created_at`, and deliberately so. `created_at` defaults to `now()`, which
in Postgres is transaction start time, so a long transaction can commit a row with a lower
`created_at` than one already visible. `id` from a BIGSERIAL is monotonic in insert order. Sorting on
`created_at` would also reintroduce the tie-nondeterminism that has bitten the seeded tests in
earlier slices.

Rows are always filtered by the caller's workspace. Rows with `workspace_id IS NULL` are global and
are never returned by this endpoint.

**No web page ships in P.** The endpoint exists so the audit trail is verifiable in a live
deployment; the audit log UI and export belong to 4A and 4F.

---

## 8. The worker's missing workspace filter

`apps/worker/src/runTask.ts:56` calls `getConnectionWithPayload(deps.pool, node.connectionRef)`,
omitting the optional `workspaceId` parameter, so a published IR referencing another tenant's
connection UUID resolves it. Publish-time validation is the only guard today.

Envelope encryption removes the choice: decryption now requires the workspace identity, so the
filter has to be threaded through regardless. `runNodeTask` already has
`detail.execution.workspaceId`; `resolveConnection` takes it as a parameter and passes it to both
the lookup and the vault. Fixing it here rather than separately avoids touching the same function
twice.

---

## 9. Files

**New**

| Path | Responsibility |
|---|---|
| `packages/db/src/crypto/keyProvider.ts` | `KeyProvider`, `localKeyProvider`, `gcpKmsKeyProvider`, `KmsClientLike` |
| `packages/db/src/crypto/keyring.ts` | `WorkspaceKeyring`: get-or-create workspace KEK, TTL cache |
| `packages/db/src/crypto/vault.ts` | `SecretVault`, v1 blob codec, v0 fallback |
| `packages/db/src/crypto/rekey.ts` | `rekeyAll` |
| `packages/db/src/repos/audit.ts` | `appendAuditEvent`, `listAuditEvents` |
| `packages/db/src/migrations/0012_security.sql` | `workspace_keys`, `audit_events`, four `enc_version` columns |
| `apps/api/src/routes/audit.ts` | `GET /v1/audit` |

**Modified**

`packages/db/src/crypto.ts` (drop `deriveTriggerKey`, add optional `aad`), `packages/db/src/index.ts`,
the four repos that read or write an encrypted column (`connections`, `triggers`, `workflows`,
`alerts`), `apps/api/src/server.ts` and `routes/deps.ts` (vaults replace `triggerKey`/`credentialsKey`),
`apps/api/src/auth/permissions.ts` (`audit:read`), the five route files listed in the action catalog,
`apps/gateway/src/{main,server}.ts`, `apps/worker/src/{main,runTask,callback,alertDelivery}.ts`,
`apps/cli` (the `rekey` command).

Every encrypt/decrypt call site becomes `await`-ing. All nine are already inside async functions.
One needs restructuring: `triggerView` in `routes/triggers.ts:33` is called from a `.map()` and
becomes `await Promise.all(...)`.

### Repo reads that must widen

The vault needs a workspace id to derive a key, and three of the four reads that return a secret do
not currently select one. This is not incidental — it is the same missing-tenant-scope defect as the
worker's, in three more places, and envelope encryption forces all of them into the open:

| Function | Today returns | Must also return |
|---|---|---|
| `getConnectionWithPayload` (`repos/connections.ts:42`) | `ConnectionRow & { encryptedPayload }` | `encVersion`; and `workspaceId` becomes a required parameter, not optional |
| `getTriggerByRouteKey` (`repos/triggers.ts:84`) | `TriggerRow`, which has no `workspaceId` | `workspaceId`, `secretEncVersion` |
| `getWorkflowCallback` (`repos/workflows.ts:150`) | `{ url, secretEncrypted }` | `workspaceId`, `encVersion` |
| `getAlertWebhook` (`repos/alerts.ts:210`) | `{ url, secretEncrypted }` | `workspaceId`, `encVersion` |

Making `workspaceId` required on `getConnectionWithPayload` is what turns the worker's omission from
a silent default into a compile error, so the fix in §8 cannot regress later.

---

## 10. Tests

Vitest, existing 80% thresholds on lines/statements/functions/branches.

**`keyProvider`** — local round-trip; the same master secret in two provider instances unwraps the
other's output; two wraps of the same key differ (random IV) and both unwrap; the GCP provider
against a fake `KmsClientLike` asserts the configured `name` is passed, that Buffer↔Uint8Array
conversion is correct, and that a response missing `ciphertext`/`plaintext` throws instead of
producing an empty Buffer.

**`keyring`** — creates a KEK on first use; a second call does not call `unwrap` again (asserted on
the provider's call count); expiry re-unwraps; **two keyring instances racing on one workspace
converge on a single KEK and each can decrypt the other's blobs.** That last test must fail when the
step-3 re-read is removed — verified by deliberately breaking it, as in 3M and 3N.

**`vault`** — v1 round-trip; a v0 blob written with the legacy key decrypts through the same vault;
a blob moved from workspace A to workspace B fails (AAD binding); a version/marker mismatch throws.

**`rekey`** — seeded v0 rows re-key to v1 with plaintext unchanged; a partial run leaves a mixed
state where both formats read correctly; a second run is a no-op.

**`audit`** — a rolled-back connection create leaves zero audit rows and a committed one leaves
exactly one; workspace isolation on `GET /v1/audit`; a `workspace_id IS NULL` row is never returned;
keyset pagination returns each row exactly once across pages. The existing RBAC matrix test picks up
`audit:read` automatically via `ALL_PERMISSIONS` and will fail until the route is wired.

**Live GCP verification is deferred.** P ships unit-tested against the fake client. Verifying
against a real CryptoKey requires a project, a key ring and a service account, and whoever holds
that account places its credentials in their own local `.env`.

---

## 11. Consequences

**KMS becomes a hard runtime dependency for credentialed workflows.** With `KMS_PROVIDER=gcp-kms`,
if KMS is unreachable and the workspace KEK is not cached, credential resolution **fails closed** —
the node fails with `connection_invalid` rather than guessing. The alternative, serving an expired
cached key indefinitely, would make key destruction non-immediate and was rejected at the design
gate. `KEK_CACHE_TTL_MS` is the availability lever, and unwrap failures surface through the existing
2J alerting path.

**Legacy keys stay configured until backfill completes.** `TRIGGER_SECRET_KEY` and
`CREDENTIALS_SECRET_KEY` remain required. Removing them is a follow-up gated on
`SELECT count(*) WHERE enc_version = 0` reaching zero on all four columns.

**Deleting a workspace destroys both its KEK and its audit trail.** The first is the intent; the
second is a limitation 4E and 4F resolve.

## 12. Out of scope

| Item | Why |
|---|---|
| SEC-007 scheduled key rotation | P builds the re-key primitive the backfill needs, but no schedule, no root-key retirement, no UI |
| SEC-008 external secret manager | A different integration from KMS envelope encryption |
| SEC-010 short-lived worker credential grants | Requires a worker identity model P does not introduce |
| Audit retention, legal hold, immutability proofs | 4E; and if SOC 2 is the driver, the auditor sets the requirements, not us |
| Audit export | 4F |
| Audit log UI | 4A |
