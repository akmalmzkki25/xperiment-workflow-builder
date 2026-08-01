# 4B — MFA TOTP (AUTH-004) Design

**Status:** approved 2026-08-01
**Requirement:** PRD AUTH-004, "MFA TOTP untuk admin/workspace owner", priority Should.

## 1. Scope

A TOTP second factor that any user may enable, plus a workspace policy an owner may
switch on to require it of privileged members. Ten single-use recovery codes are the only
way back in without the authenticator.

Out of scope, deliberately: WebAuthn, SMS, owner-initiated reset of another member's MFA,
and remembering a trusted device. Each would be its own slice.

## 2. TOTP core — `packages/db/src/totp.ts`

A pure module beside `authCrypto.ts`: no database access, no clock ownership beyond an
injectable `now`.

```ts
export function generateTotpSecret(): { secret: Buffer; base32: string };
export function totpCode(secret: Buffer, counter: number, digits?: number): string;
export function verifyTotpCode(args: {
  secret: Buffer;
  code: string;
  now?: number;
  window?: number;
  after?: number | null;
}): number | null;
export function otpauthUri(args: { issuer: string; account: string; base32: string }): string;
export function base32Encode(buf: Buffer): string;
export function base32Decode(s: string): Buffer;
```

HMAC-SHA1, 30-second step, 6 digits — what every authenticator app assumes. `digits` is a
parameter so the **official RFC 6238 test vectors can be asserted directly** (that table is
8 digits). Correctness is proven against the RFC rather than trusted. `base32Encode` /
`base32Decode` follow RFC 4648 without padding and are tested against that RFC's vectors.

`verifyTotpCode` returns the matched step number, or `null`. It accepts `window = 1` step
either side of the current one for clock drift, and refuses any step at or below `after`.
The comparison is constant-time.

A ±1 window means one code is live for 90 seconds. `after` is what stops that window from
being a replay window; see §3.

## 3. Storage — migration `0014_mfa.sql`

```sql
CREATE TABLE user_mfa (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc     BYTEA NOT NULL,
  root_key_id    TEXT NOT NULL,
  confirmed_at   TIMESTAMPTZ NULL,
  last_used_step BIGINT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,
  consumed_at TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

ALTER TABLE workspaces ADD COLUMN require_mfa BOOLEAN NOT NULL DEFAULT false;
```

`user_id` is the primary key, so two concurrent enrolments collide on a constraint instead
of racing. `confirmed_at IS NULL` marks a secret that was generated but never proven; it is
not a second factor and no login consults it.

`last_used_step` is the replay guard. Without it a code observed once — over a shoulder, in
a proxy log, in a screenshot — stays valid for the rest of its 90-second window.

### Why the root key and not `SecretVault`

The vault is workspace-scoped, and MFA is an account-level fact. Filing the secret under
one workspace would mean destroying that workspace's key locks the user out of every
*other* workspace, which is wrong. The secret is therefore wrapped directly by the root key
via `keyProvider.wrap()`, and `root_key_id` is recorded so a deployment pointed at the
wrong key fails loudly rather than silently rejecting every code — the lesson from slice P.

**Cost, stated plainly:** under `KMS_PROVIDER=gcp-kms` this is one KMS decrypt per
MFA login. At human login rates that is acceptable; it is documented in the README so
nobody discovers it from a bill.

## 4. Enrolment

All four routes are session-only; an API key has no second factor to manage and gets
`400 Sessions only`.

| Route | Behaviour |
|---|---|
| `POST /v1/auth/mfa/setup` | Generates a secret, stores it unconfirmed (replacing any prior unconfirmed row), returns `{ otpauthUri, secretBase32 }`. `409` if MFA is already confirmed. |
| `POST /v1/auth/mfa/confirm` | `{ code }`. Verifies against the pending secret, sets `confirmed_at`, issues ten recovery codes and returns them **once**. Emits `auth.mfa_enabled`. |
| `POST /v1/auth/mfa/disable` | `{ code }` — a TOTP or recovery code. Deletes the row and the codes. Emits `auth.mfa_disabled`. |
| `POST /v1/auth/mfa/recovery-codes` | `{ code }`. Replaces the whole set and returns the new one once. Emits `auth.mfa_recovery_regenerated`. |

`disable` and `recovery-codes` demand a live code rather than accepting the session alone:
a stolen session must not be able to switch the second factor off or mint itself a fresh
set of bypasses.

The secret is returned exactly once, at `setup`, and never again after confirmation.

## 5. Login becomes two steps

`POST /v1/auth/login` with a correct password and **no** confirmed MFA behaves exactly as
today and returns `{ token }`.

With confirmed MFA it issues **no session**. It returns `200 { mfaRequired: true, challenge }`,
where the challenge is an `auth_tokens` row of purpose `mfa_challenge` with a five-minute
TTL. This reuses AUTH-002's purpose-checked compare-and-set rather than inventing a second
single-use mechanism; `generateToken` widens to accept `'qm'`. Emits `auth.mfa_challenged`.

`POST /v1/auth/mfa/verify` takes `{ challenge, code }`, is public — it goes in the auth
plugin's `EXEMPT` set, because a caller who has not finished logging in has no session to
present — and is rate-limited on the challenge. It reads the challenge without consuming it, verifies the
code, and only then consumes it via the CAS before creating the session. A wrong code
therefore does **not** burn the challenge — one mistyped digit must not force the password
back through — but it counts against the limiter, and once the limiter refuses further
attempts the challenge is destroyed rather than left sitting there for the next minute's
worth of guesses.

Success emits `auth.login_succeeded`, so existing login auditing keeps its meaning, plus
`auth.mfa_verified` or `auth.mfa_recovery_used`. A recovery code is consumed by the same
CAS; the response reports how many remain so an empty set is visible before it matters.

`peekAuthToken(db, hash, purpose)` is added beside `consumeAuthToken` for the read-then-
verify-then-consume shape.

A wrong code emits `auth.mfa_failed`; the destroyed-challenge case emits it too, with
`reason: 'too_many_attempts'` in metadata.

### What the client can see

`GET /v1/auth/me` gains `mfaEnabled: boolean` (confirmed enrolment only), and each entry of
its `workspaces` array gains `requireMfa: boolean`. Those two fields are what the
`/security` page renders from; no separate policy-read endpoint is added.

**Password reset does not bypass MFA.** After a reset the next login still meets the
challenge. If it did not, anyone holding the mailbox would walk straight past the second
factor and MFA would mean nothing.

## 6. Enforcement

`PUT /v1/workspaces/mfa-policy` (owner only) sets `workspaces.require_mfa` and emits
`workspace.mfa_policy_change`.

**Turning it on requires the caller to have confirmed MFA already.** Otherwise the owner
locks themselves out of their own workspace inside the same request.

Enforcement lives in the auth plugin, after `authContext` resolves: policy on, role `owner`
or `admin`, no confirmed MFA → `403 MFA required`. This is a **second, separate** carve-out
list from `EXEMPT`: `EXEMPT` decides who needs a session at all, this one decides which
authenticated routes stay reachable while the policy is unmet. Exempt from the MFA check,
so the account can be fixed: `/v1/auth/me`, every `/v1/auth/mfa/*` route, and
`/v1/auth/logout`. Without that carve-out the policy makes the workspace permanently
unusable — the dead-route trap that caught the payments webhook in 3O and the recovery
routes in AUTH-002.

`disable` is refused with `409` while the caller is a privileged member of a workspace that
requires MFA.

### Accepted hole: API keys are not covered

The policy applies to sessions only. An API key is not a human and cannot present a code,
so enforcing the policy against keys would break every running automation the moment an
owner flips the switch. A key carrying the admin role therefore keeps full access under the
policy. This is a decision, not an oversight, and the README says so: an admin API key is a
credential the workspace already chose to issue, and revoking it is the control that
applies.

### Accepted hole: no owner-initiated reset

A member who loses both the authenticator and the recovery codes loses the account. The
alternative — letting an owner reset a member's second factor — makes the owner account a
shortcut into every member account, and the owner still needs their own way out. Recovery
codes are the answer; the enrolment UI says so in as many words.

## 7. Audit

New actions, all `workspace_id` null except the policy change, which belongs to its
workspace:

`auth.mfa_enabled`, `auth.mfa_disabled`, `auth.mfa_challenged`, `auth.mfa_verified`,
`auth.mfa_failed`, `auth.mfa_recovery_used`, `auth.mfa_recovery_regenerated`, and
`workspace.mfa_policy_change` (metadata: `enabled`).

No secret, base32 string, `otpauth://` URI, recovery code, or submitted TOTP code ever
appears in metadata or in a log line.

## 8. Web

A `/security` page under `(app)` with two panels:

- **Your account** — state, the enrolment wizard (QR rendered in the browser from the
  `otpauth://` URI, with the formatted key for manual entry), the recovery codes shown once
  with a copy control and an explicit warning that they are the only way back, disable, and
  regenerate.
- **This workspace** — the `require_mfa` toggle, owner only, disabled with an explanation
  when the owner has not enrolled.

The QR is generated client-side; the secret never reaches a third-party service. `AuthForm`
grows a second step in place when a login answers `mfaRequired`, and a nav entry points at
`/security`.

## 9. Testing

- **RFC vectors.** All six RFC 6238 SHA-1 rows at 8 digits, and RFC 4648 base32 vectors.
- **Replay.** The same code twice: the second is refused. Break-it: remove the
  `last_used_step` guard and prove the replay succeeds.
- **Window.** The previous step's code is accepted; two steps back is refused.
- **Login.** An enrolled user gets no token; challenge plus code yields one; a wrong code
  leaves the challenge usable; exhausting the limiter destroys it; an expired challenge gives
  the same generic `400` as an unknown one.
- **Recovery.** Single use, and a spent code is dead. Regenerating invalidates the old set.
- **Policy.** An owner without MFA cannot switch it on. A privileged member without MFA
  gets `403` on an ordinary route but `200` on `/v1/auth/mfa/setup`. Break-it: drop the
  carve-out and prove the workspace becomes unfixable.
- **Disable** is refused while a policy requires the caller's MFA.
- **Leak sweep.** No audit row and no log line carries a secret, a base32 string, an
  `otpauth://` URI, or a recovery code.
- Coverage stays at the repo's 80% thresholds; the suite runs with `pnpm test`, never
  `pnpm -r test`.
