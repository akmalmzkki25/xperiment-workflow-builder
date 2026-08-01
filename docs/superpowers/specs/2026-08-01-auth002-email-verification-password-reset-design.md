# AUTH-002 — Email Verification & Password Reset

**Status:** design approved 2026-08-01.
**Covers:** AUTH-002 (PRD priority **Must**), entirely absent today.
**Why now:** the PRD audit on 2026-07-31 found AUTH-002 unbuilt while the next planned
slice, 4B (MFA TOTP), is priority *Should*. Shipping MFA first would add a second way to
be locked out of an account that already has no recovery path at all.

---

## 1. Three findings that shape this

**The platform has no transactional email, and the SMTP connector is not the answer.**
`packages/connectors/src/email/send.ts` reads an `smtp` connection payload out of the
*workspace* credential vault — that is a tenant's mail server. Using it for password reset
would have the platform borrow tenant credentials to send platform mail, letting a tenant
intercept its own users' reset tokens. Wrong layer. `nodemailer` is already a dependency of
`packages/connectors`, so the transport itself is available.

**`users.status` is a vestigial column with a trap.** Nothing ever writes it beyond the
`'active'` default, but `getActiveSession` (`repos/auth.ts:59`) filters on
`u.status = 'active'` while login's `getUserByEmail` does not check status at all. Using
`status = 'pending'` for verification would produce a broken half-state: login succeeds and
returns a token, then every authenticated request 401s with "Invalid or expired session".
This slice adds `users.email_verified_at` instead — a suspended account and an unverified
account are different things, and one column cannot express both.

**Blocking login on unverified email would touch 89 `createAuthedUser` calls across 25
files** plus two e2e suites. Per the design gate, verification is recorded and surfaced but
enforces nothing; enforcement can be its own slice.

## 2. The mailer

Lives in `apps/api/src/mail/`, not a new package: only the api sends platform mail. Promote
it to `packages/mailer` when a second consumer appears, not before.

```ts
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text only. HTML templating is out of scope. */
  text: string;
}

export interface MailSender {
  readonly name: 'log' | 'smtp' | 'memory';
  send(message: MailMessage): Promise<void>;
}
```

Three implementations:

| Sender | Use | Behaviour |
|---|---|---|
| `smtpMailSender(cfg)` | production | nodemailer, platform credentials from env |
| `logMailSender(log)` | dev | writes the message to the log |
| `memoryMailSender()` | tests | returns `{ sender, sent: MailMessage[] }` |

`memoryMailSender` is not a convenience. The raw token exists **only inside the email**, so
without a sender that records messages there is no way for a test to drive the flows
end to end.

`createMailSenderFromEnv(env?, transportFactory?)` validates at startup, matching
`createKeyProviderFromEnv` and `resolvePaymentProvider`: an unknown `MAIL_TRANSPORT`
throws, and `MAIL_TRANSPORT=smtp` without `SMTP_HOST` or `MAIL_FROM` throws. A
misconfiguration fails the boot rather than every password reset.

| Env | Default | Meaning |
|---|---|---|
| `MAIL_TRANSPORT` | `log` | `log` or `smtp` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | — | required when `smtp` |
| `MAIL_FROM` | — | required when `smtp` |
| `APP_URL` | `http://localhost:3005` | base for the links in the emails |

**`logMailSender` writes reset links to the log, which is a production hazard.** It emits a
warning once on construction, and `.env.example` says so plainly.

## 3. Token storage

One table — both purposes share every column:

```sql
CREATE TABLE auth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id, purpose);
```

Hashed at rest with the existing `hashToken`; the raw token appears only in the email.
`generateToken` widens to accept `'qv'` and `'qr'` alongside `'qs'`/`'qk'`.

TTLs: `email_verify` 24 hours, `password_reset` 1 hour.

**Consumption is a compare-and-set, and it checks the purpose:**

```sql
UPDATE auth_tokens SET consumed_at = now()
 WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
 RETURNING user_id
```

Single use is guaranteed under concurrency — the same discipline as `markInvoicePaid`. The
`purpose = $2` term is load-bearing: without it a verification token, which has a 24-hour
life and is mailed on every registration, could be replayed against the reset endpoint to
change a password.

**Every token failure returns one generic 400** — "Invalid or expired token" — whether the
token is unknown, expired, already consumed, or of the wrong purpose. Distinguishing them
would turn the endpoint into an oracle telling an attacker which of a stolen batch is still
live.

## 4. Email verification

Registration creates an `email_verify` token, mails it, and emits
`auth.email_verify_requested`. `POST /v1/auth/verify-email` `{token}` consumes it, sets
`users.email_verified_at`, and emits `auth.email_verified`. `GET /v1/auth/me` gains
`emailVerified: boolean` so the web can show its banner.

`POST /v1/auth/resend-verification` is authenticated, issues a fresh token, and emits
`auth.email_verify_requested` again. It is rate-limited through the same `LoginLimiter`
instance but keyed on **`userId:ip`** rather than email+ip, because the caller is already
identified and the email is not in the request body.

**Registration must not fail when mail fails.** An SMTP outage cannot be allowed to block
every signup, so the send is best-effort with a logged warning — the same posture as the
best-effort AI usage recording in Phase 2I.

## 5. Password reset

`POST /v1/auth/forgot-password` `{email}` **returns 200 whether or not the address
exists**. Enumeration resistance is the point: a 404 for unknown addresses turns the
endpoint into a membership oracle. Rate-limited through the existing `LoginLimiter`, keyed
on email+ip as login is. A send failure still returns 200 — neither leak nor 500.

`POST /v1/auth/reset-password` `{token, password}`, in one transaction:

1. consume the token (CAS, purpose `password_reset`);
2. write the new `password_hash`;
3. **revoke every session for that user**, via the existing `revokeAllSessions`;
4. mark that user's other live `password_reset` tokens consumed — set `consumed_at`, not
   delete, so the audit trail of how many resets were in flight survives;
5. emit `auth.password_reset_completed`.

Step 3 is the one that is usually forgotten. Without it an attacker holding a stolen
session keeps it after the victim resets, which makes the reset theatre. A test asserts an
existing session token stops working.

Password rules reuse the existing `z.string().min(8)`.

## 6. Audit

Four new actions, all global (`workspace_id` null, as `auth.login_failed` already is,
because they are account-level and pre-date any workspace context):
`auth.email_verify_requested`, `auth.email_verified`, `auth.password_reset_requested`,
`auth.password_reset_completed`.

`auth.password_reset_requested` is emitted **only when the address matches a user**. The
API response is identical either way, so this leaks nothing to the requester; and these
rows carry no workspace, so §7 of the P design guarantees they never surface in a
workspace's audit view. No raw token reaches metadata.

## 7. Web

Three public pages following the existing `/login` and `/register` pattern —
`/forgot-password`, `/reset-password?token=`, `/verify-email?token=` — plus a banner in the
app shell when `me.emailVerified` is false, carrying a resend action.

## 8. Testing

- **Mailer:** the log sender records; the smtp sender hands the right envelope to an
  injected transport factory; the env factory throws on an unknown transport and on `smtp`
  with no host or from-address.
- **Token repo:** create/consume round-trip; **concurrent consumption elects exactly one
  winner**, verified by breaking the CAS and confirming the test fails; an expired token is
  refused; **an `email_verify` token is refused by the reset endpoint**.
- **Reset:** `forgot-password` returns 200 and emits nothing for an unknown address, 200
  and sends mail for a known one; completing a reset invalidates a session token issued
  beforehand; a second use of the same reset token fails.
- **Verification:** registration still succeeds when the sender throws; `me.emailVerified`
  flips after verifying; resend is rate-limited.
- **Audit:** all four actions appear, and no row's metadata contains the raw token.
- **Playwright:** the three public pages render, validate their inputs, and a full
  forgot → reset → login-with-the-new-password journey driven by the memory sender.

Coverage thresholds stay 80% on lines/statements/functions/branches per package. The full
suite runs with **`pnpm test`**, never `pnpm -r test`.

## 9. Out of scope

| Item | Note |
|---|---|
| Emailing workspace invites | Backlog by explicit choice; `POST /v1/workspaces/invites` keeps returning the raw token |
| Enforcing verification | Banner only; blocking login is its own slice, and would touch 89 test call sites |
| HTML email templates | Plain text only |
| Google OAuth (AUTH-001's other half) | Still unbuilt, still Must |
| MFA TOTP | 4B, next |
