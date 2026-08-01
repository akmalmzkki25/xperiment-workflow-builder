# AUTH-002 — Email Verification & Password Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Xperiment accounts a recovery path — verify an address, and reset a forgotten password — neither of which exists today.

**Architecture:** A platform mailer with a `MailSender` contract (smtp / log / memory) lives in the api, validated at startup like `KeyProvider` and `PaymentProvider`. One `auth_tokens` table serves both flows, and its consume is a compare-and-set that also matches the token's purpose, so a long-lived verification token cannot be replayed against the reset endpoint.

**Tech Stack:** TypeScript (ESM, run by tsx), Postgres 16 via `pg`, Fastify 5, nodemailer, Next.js 15 + TanStack Query, Vitest 2, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-auth002-email-verification-password-reset-design.md` (commit `6dc54a7`).

## Global Constraints

- Coverage thresholds are 80% on lines, statements, functions **and** branches, per package.
- **Run the full suite with `pnpm test`, never `pnpm -r test`.** The root script pins `--workspace-concurrency=1`; run concurrently, `@xperiment/queue`'s outbox publisher races other suites over `task_outbox`.
- Conventional commits: `<type>: <description>`. **No attribution trailer.**
- TypeScript is strict with `noUncheckedIndexedAccess`.
- **A raw token may never be logged, returned in an API response, or written to audit metadata.** It exists in exactly two places: the email body, and the `token_hash` column.
- **Every token failure returns one generic 400** — "Invalid or expired token" — whether unknown, expired, consumed, or of the wrong purpose. Distinguishing them makes the endpoint an oracle.
- `POST /v1/auth/forgot-password` returns **200 unconditionally**, including for unknown addresses and when the send fails.
- Audit rows for these four actions carry `workspace_id: null`, like `auth.login_failed`.
- No `console.log` in application code.
- Docker `postgres` and `redis` must be up; `docker compose ps` prints nothing here because they run under a different compose project — check `docker ps`.

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `apps/api/src/mail/sender.ts` | `MailSender`, `MailMessage`, `logMailSender`, `memoryMailSender`, `smtpMailSender`, `createMailSenderFromEnv` |
| `apps/api/src/mail/messages.ts` | The two message bodies and their links — one place that knows the copy and the URL shape |
| `packages/db/src/migrations/0013_auth_tokens.sql` | `auth_tokens`, `users.email_verified_at` |
| `packages/db/src/repos/authTokens.ts` | `createAuthToken`, `consumeAuthToken`, `consumeOtherTokens` |
| `apps/api/test/mail.test.ts` | Sender contract and env validation |
| `packages/db/test/authTokens.test.ts` | CAS, purpose, expiry, concurrency |
| `apps/api/test/passwordReset.test.ts` | Both flows end to end through the memory sender |
| `apps/web/src/app/forgot-password/page.tsx`, `reset-password/page.tsx`, `verify-email/page.tsx` | Three public pages |
| `apps/web/src/components/shell/VerifyBanner.tsx` | Unverified banner |

**Modify**

| Path | Change |
|---|---|
| `packages/db/src/authCrypto.ts` | `generateToken` accepts `'qv'` / `'qr'` |
| `packages/db/src/repos/auth.ts` | `UserRow` gains `emailVerifiedAt`; `markEmailVerified`, `updatePassword` |
| `packages/db/src/index.ts` | export the token repo |
| `apps/api/src/routes/deps.ts`, `apps/api/src/server.ts` | `mailSender` in deps |
| `apps/api/src/routes/auth.ts` | four routes, register sends, `me` gains `emailVerified` |
| `apps/web/src/lib/api.ts` | four client methods, `MeResponse.emailVerified` |
| `apps/web/src/app/(app)/layout.tsx` | render `VerifyBanner` |
| `apps/web/src/components/auth/AuthForm.tsx` | "Forgot password?" link |
| `.env.example`, `README.md` | mail settings and the log-transport hazard |

**Ordering.** Task 1 (mailer) and Task 2 (table + repo) are independent. Tasks 3 and 4 each need both. Task 5 needs 3 and 4. Task 6 verifies.

---

### Task 1: The platform mailer

**Files:**
- Create: `apps/api/src/mail/sender.ts`, `apps/api/src/mail/messages.ts`, `apps/api/test/mail.test.ts`
- Modify: `apps/api/src/routes/deps.ts`, `apps/api/src/server.ts`, `apps/api/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  interface MailMessage { to: string; subject: string; text: string }
  interface MailSender { readonly name: 'log' | 'smtp' | 'memory'; send(m: MailMessage): Promise<void> }
  interface MailTransportLike { sendMail(o: { from: string; to: string; subject: string; text: string }): Promise<unknown> }
  function logMailSender(log: (msg: string, extra?: Record<string, unknown>) => void): MailSender;
  function memoryMailSender(): { sender: MailSender; sent: MailMessage[] };
  function smtpMailSender(cfg: { from: string; transport: MailTransportLike }): MailSender;
  function createMailSenderFromEnv(env?: NodeJS.ProcessEnv, transportFactory?: (cfg: SmtpConfig) => MailTransportLike): MailSender;
  function verifyEmailMessage(to: string, appUrl: string, token: string): MailMessage;
  function passwordResetMessage(to: string, appUrl: string, token: string): MailMessage;
  // ResolvedServerDeps gains: mailSender: MailSender; appUrl: string
  ```

- [ ] **Step 1: Add nodemailer to the api**

In `apps/api/package.json`, add to `dependencies`:

```json
"nodemailer": "^9.0.3",
```

and to `devDependencies`:

```json
"@types/nodemailer": "^8.0.1",
```

Then:

```bash
cd "<repo-root>" && pnpm install
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/mail.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import {
  createMailSenderFromEnv,
  logMailSender,
  memoryMailSender,
  smtpMailSender,
  type MailTransportLike,
} from '../src/mail/sender.js';
import { passwordResetMessage, verifyEmailMessage } from '../src/mail/messages.js';

describe('memoryMailSender', () => {
  test('records what it was asked to send', async () => {
    const { sender, sent } = memoryMailSender();
    await sender.send({ to: 'a@b.test', subject: 'Hi', text: 'body' });
    expect(sender.name).toBe('memory');
    expect(sent).toEqual([{ to: 'a@b.test', subject: 'Hi', text: 'body' }]);
  });
});

describe('logMailSender', () => {
  test('logs the message and warns once that it must not be used in production', async () => {
    const lines: string[] = [];
    const sender = logMailSender((msg) => lines.push(msg));
    await sender.send({ to: 'a@b.test', subject: 'Hi', text: 'body' });
    await sender.send({ to: 'c@d.test', subject: 'Yo', text: 'body2' });
    // One construction warning, then one line per message.
    expect(lines.filter((l) => /not for production/i.test(l))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('a@b.test'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('c@d.test'))).toHaveLength(1);
  });
});

describe('smtpMailSender', () => {
  test('hands the envelope to the transport with the configured from-address', async () => {
    const calls: Record<string, string>[] = [];
    const transport: MailTransportLike = {
      async sendMail(o) {
        calls.push(o as unknown as Record<string, string>);
        return {};
      },
    };
    const sender = smtpMailSender({ from: 'Xperiment <no-reply@xperiment.test>', transport });
    await sender.send({ to: 'a@b.test', subject: 'Hi', text: 'body' });
    expect(sender.name).toBe('smtp');
    expect(calls[0]).toEqual({
      from: 'Xperiment <no-reply@xperiment.test>',
      to: 'a@b.test',
      subject: 'Hi',
      text: 'body',
    });
  });

  test('a transport failure propagates rather than being swallowed', async () => {
    const transport: MailTransportLike = {
      async sendMail() {
        throw new Error('smtp down');
      },
    };
    const sender = smtpMailSender({ from: 'x@y.test', transport });
    await expect(sender.send({ to: 'a@b.test', subject: 'S', text: 'T' })).rejects.toThrow('smtp down');
  });
});

describe('createMailSenderFromEnv', () => {
  test('defaults to the log transport', () => {
    expect(createMailSenderFromEnv({}).name).toBe('log');
  });

  test('smtp builds from the injected factory and uses MAIL_FROM', () => {
    const factory = vi.fn(() => ({ async sendMail() { return {}; } }) as MailTransportLike);
    const sender = createMailSenderFromEnv(
      { MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.test', SMTP_PORT: '587', MAIL_FROM: 'x@y.test' },
      factory,
    );
    expect(sender.name).toBe('smtp');
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: 'mail.test', port: 587 }));
  });

  test('smtp without a host fails at startup, not at first send', () => {
    expect(() => createMailSenderFromEnv({ MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'x@y.test' })).toThrow(/SMTP_HOST/);
  });

  test('smtp without a from-address fails at startup', () => {
    expect(() => createMailSenderFromEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.test' })).toThrow(/MAIL_FROM/);
  });

  test('an unknown transport is rejected rather than silently falling back to log', () => {
    expect(() => createMailSenderFromEnv({ MAIL_TRANSPORT: 'carrier-pigeon' })).toThrow(/MAIL_TRANSPORT/);
  });
});

describe('messages', () => {
  test('each carries a working link and never the bare token alone', () => {
    const verify = verifyEmailMessage('a@b.test', 'https://app.test', 'qv_abc');
    expect(verify.to).toBe('a@b.test');
    expect(verify.text).toContain('https://app.test/verify-email?token=qv_abc');

    const reset = passwordResetMessage('a@b.test', 'https://app.test', 'qr_xyz');
    expect(reset.text).toContain('https://app.test/reset-password?token=qr_xyz');
    // The reset mail must say how long it lives, or people sit on a dead link.
    expect(reset.text).toMatch(/1 hour/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/mail.test.ts
```

Expected: FAIL — `Cannot find module '../src/mail/sender.js'`.

- [ ] **Step 4: Implement `apps/api/src/mail/sender.ts`**

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

/** The subset of a nodemailer transport we use, so tests need no real transport. */
export interface MailTransportLike {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

/**
 * Records messages instead of sending them. Not a convenience: a raw token exists only
 * inside the email body, so without this there is no way for a test to drive the
 * verification or reset flow end to end.
 */
export function memoryMailSender(): { sender: MailSender; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    sender: {
      name: 'memory',
      async send(message) {
        sent.push(message);
      },
    },
  };
}

/**
 * Development transport. It writes password-reset links to the log, which is a production
 * hazard, so it says so once on construction.
 */
export function logMailSender(log: (msg: string, extra?: Record<string, unknown>) => void): MailSender {
  log('mail.log_transport_selected: messages are written to the log and NOT sent — not for production use');
  return {
    name: 'log',
    async send(message) {
      log(`mail.send to=${message.to} subject=${message.subject}\n${message.text}`);
    },
  };
}

export function smtpMailSender(cfg: { from: string; transport: MailTransportLike }): MailSender {
  return {
    name: 'smtp',
    async send(message) {
      await cfg.transport.sendMail({
        from: cfg.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

const DEFAULT_SMTP_PORT = 587;

/**
 * Startup-time transport selection. A misconfiguration throws here rather than on the
 * first password reset, so a deployment fails to boot instead of silently losing every
 * recovery email. Same shape as createKeyProviderFromEnv and resolvePaymentProvider.
 *
 * `transportFactory` is injectable so tests never open a socket.
 */
export function createMailSenderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  transportFactory?: (cfg: SmtpConfig) => MailTransportLike,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
): MailSender {
  const transport = env['MAIL_TRANSPORT'] ?? 'log';
  if (transport === 'log') return logMailSender(log);
  if (transport !== 'smtp') {
    throw new Error(`Unsupported MAIL_TRANSPORT '${transport}' — expected 'log' or 'smtp'`);
  }
  const host = env['SMTP_HOST'];
  if (!host) throw new Error('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
  const from = env['MAIL_FROM'];
  if (!from) throw new Error('MAIL_FROM is required when MAIL_TRANSPORT=smtp');
  const user = env['SMTP_USER'];
  const pass = env['SMTP_PASSWORD'];
  const cfg: SmtpConfig = {
    host,
    port: Number(env['SMTP_PORT'] ?? DEFAULT_SMTP_PORT),
    secure: env['SMTP_SECURE'] === 'true',
    ...(user && pass ? { auth: { user, pass } } : {}),
  };
  const factory =
    transportFactory ??
    ((c: SmtpConfig): MailTransportLike => {
      // Imported lazily so the log transport never pulls nodemailer in.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodemailer = require('nodemailer') as { createTransport: (o: SmtpConfig) => MailTransportLike };
      return nodemailer.createTransport(c);
    });
  return smtpMailSender({ from, transport: factory(cfg) });
}
```

If `require` is unavailable under ESM in this package, replace the default factory with a
top-level `import nodemailer from 'nodemailer'` and use `nodemailer.createTransport(c) as unknown as MailTransportLike`.
Prefer whichever the api's other modules already do — check `apps/api/src/server.ts` imports.

- [ ] **Step 5: Implement `apps/api/src/mail/messages.ts`**

```ts
import type { MailMessage } from './sender.js';

/** One place that knows the copy and the URL shape, so the pages and the mail cannot drift. */
export function verifyEmailMessage(to: string, appUrl: string, token: string): MailMessage {
  return {
    to,
    subject: 'Confirm your Xperiment email address',
    text: [
      'Welcome to Xperiment.',
      '',
      'Confirm this address by opening the link below:',
      `${appUrl}/verify-email?token=${token}`,
      '',
      'The link is valid for 24 hours. If you did not create a Xperiment account, ignore this email.',
    ].join('\n'),
  };
}

export function passwordResetMessage(to: string, appUrl: string, token: string): MailMessage {
  return {
    to,
    subject: 'Reset your Xperiment password',
    text: [
      'Someone asked to reset the password for this Xperiment account.',
      '',
      'Set a new password with the link below:',
      `${appUrl}/reset-password?token=${token}`,
      '',
      'The link is valid for 1 hour and can be used once.',
      'If this was not you, ignore this email — your password has not changed.',
    ].join('\n'),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/api exec vitest run test/mail.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 7: Wire it into the server**

In `apps/api/src/routes/deps.ts`, add to `ResolvedServerDeps`:

```ts
  mailSender: import('../mail/sender.js').MailSender;
  /** Base URL the emailed links point at. */
  appUrl: string;
```

In `apps/api/src/server.ts`, add to `ServerDeps` the optional overrides `mailSender?: MailSender` and `appUrl?: string`, import `createMailSenderFromEnv`, and add to `resolvedDeps`:

```ts
    mailSender: deps.mailSender ?? createMailSenderFromEnv(process.env, undefined, (m) => app.log.warn(m)),
    appUrl: deps.appUrl ?? process.env['APP_URL'] ?? 'http://localhost:3005',
```

- [ ] **Step 8: Typecheck, full api suite, commit**

```bash
pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/api test
git add apps/api/src/mail apps/api/src/routes/deps.ts apps/api/src/server.ts apps/api/test/mail.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat: add the platform mailer with log, smtp and memory senders"
```

---

### Task 2: `auth_tokens` and its purpose-checked compare-and-set

**Files:**
- Create: `packages/db/src/migrations/0013_auth_tokens.sql`, `packages/db/src/repos/authTokens.ts`, `packages/db/test/authTokens.test.ts`
- Modify: `packages/db/src/authCrypto.ts`, `packages/db/src/repos/auth.ts`, `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `hashToken`, `generateToken` from `packages/db/src/authCrypto.ts`.
- Produces:
  ```ts
  type AuthTokenPurpose = 'email_verify' | 'password_reset';
  const EMAIL_VERIFY_TTL_MS = 86_400_000;   // 24 hours
  const PASSWORD_RESET_TTL_MS = 3_600_000;  // 1 hour
  function createAuthToken(db: Db, args: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: Date }): Promise<{ id: string }>;
  function consumeAuthToken(db: Db, tokenHash: string, purpose: AuthTokenPurpose): Promise<{ userId: string } | null>;
  function consumeOtherTokens(db: Db, userId: string, purpose: AuthTokenPurpose): Promise<number>;
  // repos/auth.ts additions:
  function markEmailVerified(db: Db, userId: string): Promise<void>;
  function updatePassword(db: Db, userId: string, passwordHash: string): Promise<void>;
  // UserRow gains: emailVerifiedAt: string | null
  // generateToken accepts 'qs' | 'qk' | 'qv' | 'qr'
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/authTokens.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createPool, generateToken, runMigrations } from '../src/index.js';
import {
  consumeAuthToken,
  consumeOtherTokens,
  createAuthToken,
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
} from '../src/repos/authTokens.js';
import { createUser, markEmailVerified, updatePassword, getUserByEmail } from '../src/repos/auth.js';

let pool: Pool;
let userId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE users CASCADE`);
  const u = await createUser(pool, { email: `t-${randomUUID()}@x.test`, passwordHash: 'h' });
  userId = u!.id;
});

/** Issues a token of `purpose` and returns its raw value. */
async function issue(purpose: 'email_verify' | 'password_reset', ttlMs?: number): Promise<string> {
  const prefix = purpose === 'email_verify' ? 'qv' : 'qr';
  const { token, hash } = generateToken(prefix);
  const ttl = ttlMs ?? (purpose === 'email_verify' ? EMAIL_VERIFY_TTL_MS : PASSWORD_RESET_TTL_MS);
  await createAuthToken(pool, { userId, purpose, tokenHash: hash, expiresAt: new Date(Date.now() + ttl) });
  return token;
}

describe('auth token lifecycle', () => {
  test('a fresh token consumes once and returns its user', async () => {
    const token = await issue('password_reset');
    const { hashToken } = await import('../src/authCrypto.js');
    expect(await consumeAuthToken(pool, hashToken(token), 'password_reset')).toEqual({ userId });
  });

  test('a second use of the same token is refused', async () => {
    const token = await issue('password_reset');
    const { hashToken } = await import('../src/authCrypto.js');
    await consumeAuthToken(pool, hashToken(token), 'password_reset');
    expect(await consumeAuthToken(pool, hashToken(token), 'password_reset')).toBeNull();
  });

  test('an expired token is refused', async () => {
    const { token, hash } = generateToken('qr');
    await createAuthToken(pool, {
      userId,
      purpose: 'password_reset',
      tokenHash: hash,
      expiresAt: new Date(Date.now() - 1000),
    });
    const { hashToken } = await import('../src/authCrypto.js');
    expect(hashToken(token)).toBe(hash);
    expect(await consumeAuthToken(pool, hash, 'password_reset')).toBeNull();
  });

  test('a verification token cannot be consumed as a password reset', async () => {
    // The whole reason consume matches on purpose. A verify token lives 24 hours and is
    // mailed on every registration; without this it could be replayed to change a password.
    const token = await issue('email_verify');
    const { hashToken } = await import('../src/authCrypto.js');
    expect(await consumeAuthToken(pool, hashToken(token), 'password_reset')).toBeNull();
    // …and is still usable for what it was issued for.
    expect(await consumeAuthToken(pool, hashToken(token), 'email_verify')).toEqual({ userId });
  });

  test('an unknown token hash is refused', async () => {
    expect(await consumeAuthToken(pool, 'no-such-hash', 'password_reset')).toBeNull();
  });

  test('concurrent consumption elects exactly one winner', async () => {
    // Without the compare-and-set both callers would see an unconsumed row and both would
    // proceed to reset the password.
    await Promise.all([...Array(5)].map(() => pool.query('SELECT 1'))); // warm the pool
    const { hashToken } = await import('../src/authCrypto.js');
    for (let i = 0; i < 4; i += 1) {
      const token = await issue('password_reset');
      const hash = hashToken(token);
      const results = await Promise.all([
        consumeAuthToken(pool, hash, 'password_reset'),
        consumeAuthToken(pool, hash, 'password_reset'),
        consumeAuthToken(pool, hash, 'password_reset'),
      ]);
      expect(results.filter((r) => r !== null), `round ${i}`).toHaveLength(1);
    }
  });

  test('consumeOtherTokens burns the rest of that purpose and leaves the other alone', async () => {
    await issue('password_reset');
    await issue('password_reset');
    const verify = await issue('email_verify');
    expect(await consumeOtherTokens(pool, userId, 'password_reset')).toBe(2);
    const { hashToken } = await import('../src/authCrypto.js');
    // The verification token is untouched.
    expect(await consumeAuthToken(pool, hashToken(verify), 'email_verify')).toEqual({ userId });
  });
});

describe('user mutations', () => {
  test('markEmailVerified stamps the column and is visible on read', async () => {
    const before = await pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [userId],
    );
    expect(before.rows[0]!.email_verified_at).toBeNull();
    await markEmailVerified(pool, userId);
    const after = await pool.query<{ email_verified_at: Date | null }>(
      `SELECT email_verified_at FROM users WHERE id = $1`,
      [userId],
    );
    expect(after.rows[0]!.email_verified_at).not.toBeNull();
  });

  test('updatePassword replaces the hash', async () => {
    const row = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
    await updatePassword(pool, userId, 'new-hash');
    const user = await getUserByEmail(pool, row.rows[0]!.email);
    expect(user!.passwordHash).toBe('new-hash');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/db exec vitest run test/authTokens.test.ts
```

Expected: FAIL — `Cannot find module '../src/repos/authTokens.js'`.

- [ ] **Step 3: Write the migration**

Create `packages/db/src/migrations/0013_auth_tokens.sql`:

```sql
-- AUTH-002. One table for both purposes: they share every column, and a `purpose`
-- discriminator keeps the consume path honest about which flow a token belongs to.
CREATE TABLE auth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  -- Hashed at rest with the same sha256 used for sessions and api keys. The raw token
  -- exists only in the email body.
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens (user_id, purpose);

-- Deliberately NOT users.status. Nothing writes status beyond its 'active' default, but
-- getActiveSession filters on it while login does not check it, so status = 'pending'
-- would let login succeed and every following request 401. A suspended account and an
-- unverified account are also different things, and one column cannot express both.
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ NULL;
```

- [ ] **Step 4: Widen `generateToken`**

In `packages/db/src/authCrypto.ts`:

```ts
export function generateToken(prefix: 'qs' | 'qk' | 'qv' | 'qr'): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}
```

- [ ] **Step 5: Implement `packages/db/src/repos/authTokens.ts`**

```ts
import { type Db } from '../pool.js';

export type AuthTokenPurpose = 'email_verify' | 'password_reset';

export const EMAIL_VERIFY_TTL_MS = 86_400_000; // 24 hours
export const PASSWORD_RESET_TTL_MS = 3_600_000; // 1 hour

export async function createAuthToken(
  db: Db,
  args: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: Date },
): Promise<{ id: string }> {
  const r = await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [args.userId, args.purpose, args.tokenHash, args.expiresAt],
  );
  return { id: (r.rows[0] as { id: string }).id };
}

/**
 * Compare-and-set: the same statement checks liveness and claims the token, so two
 * concurrent callers cannot both proceed. Matching `purpose` is not decoration — a
 * verification token lives 24 hours and is mailed on every registration, so without it
 * one could be replayed against the reset endpoint to change a password.
 *
 * Returns null for unknown, expired, already-consumed and wrong-purpose alike; the caller
 * must not distinguish them, or the endpoint becomes an oracle.
 */
export async function consumeAuthToken(
  db: Db,
  tokenHash: string,
  purpose: AuthTokenPurpose,
): Promise<{ userId: string } | null> {
  const r = await db.query(
    `UPDATE auth_tokens SET consumed_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [tokenHash, purpose],
  );
  if (!r.rowCount) return null;
  return { userId: (r.rows[0] as { user_id: string }).user_id };
}

/** Burns a user's other live tokens of one purpose. Returns how many were burnt. */
export async function consumeOtherTokens(db: Db, userId: string, purpose: AuthTokenPurpose): Promise<number> {
  const r = await db.query(
    `UPDATE auth_tokens SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
    [userId, purpose],
  );
  return r.rowCount ?? 0;
}
```

- [ ] **Step 6: Add the two user mutations**

In `packages/db/src/repos/auth.ts`, add `emailVerifiedAt: string | null` to `UserRow`, map it
in `mapUser` as `emailVerifiedAt: ts(r['email_verified_at'])` using that file's existing
timestamp helper (if `mapUser` has no `ts` helper, use
`(r['email_verified_at'] instanceof Date ? r['email_verified_at'].toISOString() : null)`),
and append:

```ts
export async function markEmailVerified(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL`, [userId]);
}

export async function updatePassword(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, passwordHash]);
}
```

- [ ] **Step 7: Export the repo**

Append to `packages/db/src/index.ts`:

```ts
export * from './repos/authTokens.js';
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
pnpm --filter @xperiment/db exec vitest run test/authTokens.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 9: Prove the compare-and-set is what makes it single-use**

Temporarily replace `consumeAuthToken`'s body with a read-then-write:

```ts
  const found = await db.query(
    `SELECT user_id FROM auth_tokens WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
    [tokenHash, purpose],
  );
  if (!found.rowCount) return null;
  await db.query(`UPDATE auth_tokens SET consumed_at = now() WHERE token_hash = $1`, [tokenHash]);
  return { userId: (found.rows[0] as { user_id: string }).user_id };
```

Run three times:

```bash
pnpm --filter @xperiment/db exec vitest run test/authTokens.test.ts -t "exactly one winner"
pnpm --filter @xperiment/db exec vitest run test/authTokens.test.ts -t "exactly one winner"
pnpm --filter @xperiment/db exec vitest run test/authTokens.test.ts -t "exactly one winner"
```

Expected: FAIL — two or three callers each get a `userId`, meaning two concurrent requests
could both reset the password. If it passes, raise the round count in the test and confirm
the pool is warmed. Restore the CAS and re-run.

- [ ] **Step 10: Typecheck and commit**

```bash
pnpm --filter @xperiment/db typecheck && pnpm --filter @xperiment/db test
git add packages/db/src packages/db/test/authTokens.test.ts
git commit -m "feat: add auth tokens with a purpose-checked single-use claim"
```

---

### Task 3: Email verification

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Create: `apps/api/test/emailVerification.test.ts`

**Interfaces:**
- Consumes: `createAuthToken`, `consumeAuthToken`, `EMAIL_VERIFY_TTL_MS`, `markEmailVerified`, `generateToken`, `hashToken`, `deps.mailSender`, `deps.appUrl`, `verifyEmailMessage`, `appendAuditEvent`, `auditActor`, the file's existing `requestFacts(req)`.
- Produces: `POST /v1/auth/verify-email`, `POST /v1/auth/resend-verification`; `GET /v1/auth/me` gains `emailVerified: boolean`. Actions `auth.email_verify_requested`, `auth.email_verified`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/emailVerification.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { memoryMailSender, type MailMessage } from '../src/mail/sender.js';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
let sent: MailMessage[];

const APP_URL = 'https://app.test';

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const mail = memoryMailSender();
  sent = mail.sent;
  app = buildServer({ pool, registry: createDefaultRegistry(), mailSender: mail.sender, appUrl: APP_URL });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
  sent.length = 0;
});

/** Registers and returns the session token plus the raw verification token from the mail. */
async function register(): Promise<{ email: string; token: string; verifyToken: string }> {
  const email = `v-${randomUUID()}@xperiment.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  expect(res.statusCode).toBe(201);
  const mail = sent.find((m) => m.to === email);
  expect(mail, 'registration should send a verification email').toBeDefined();
  const match = /token=([^\s]+)/.exec(mail!.text);
  expect(match, 'the email should carry a verification link').not.toBeNull();
  return { email, token: res.json<{ token: string }>().token, verifyToken: match![1]! };
}

async function actions(): Promise<string[]> {
  const r = await pool.query<{ action: string }>(
    `SELECT action FROM audit_events WHERE action LIKE 'auth.email%' ORDER BY id`,
  );
  return r.rows.map((x) => x.action);
}

describe('email verification', () => {
  test('registration mails a link and me reports the address unverified', async () => {
    const { token } = await register();
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(false);
    expect(await actions()).toContain('auth.email_verify_requested');
  });

  test('verifying flips me.emailVerified and audits it', async () => {
    const { token, verifyToken } = await register();
    const res = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json<{ emailVerified: boolean }>().emailVerified).toBe(true);
    expect(await actions()).toContain('auth.email_verified');
  });

  test('a second use of the same link is a generic 400', async () => {
    const { verifyToken } = await register();
    await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    const again = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    expect(again.statusCode).toBe(400);
    // One message for unknown, expired, consumed and wrong-purpose alike.
    expect(again.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('an unknown token gives the same 400 as a consumed one', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: 'qv_nonsense' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('resend issues a fresh working link', async () => {
    const { email, token } = await register();
    sent.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const mail = sent.find((m) => m.to === email);
    expect(mail).toBeDefined();
    const fresh = /token=([^\s]+)/.exec(mail!.text)![1]!;
    expect((await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: fresh } })).statusCode).toBe(200);
  });

  test('registration still succeeds when the mailer throws', async () => {
    // An SMTP outage must not block every signup.
    const failing = buildServer({
      pool,
      registry: createDefaultRegistry(),
      appUrl: APP_URL,
      mailSender: {
        name: 'memory' as const,
        async send() {
          throw new Error('smtp down');
        },
      },
    });
    await failing.ready();
    const res = await failing.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `down-${randomUUID()}@xperiment.test`, password: 'password-123' },
    });
    expect(res.statusCode).toBe(201);
    await failing.close();
  });

  test('no audit row carries the raw token', async () => {
    const { verifyToken } = await register();
    await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token: verifyToken } });
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`,
      [verifyToken],
    );
    expect(rows.rows[0]!.c).toBe('0');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/emailVerification.test.ts
```

Expected: FAIL — registration sends no mail, so `register()` throws on its first assertion.

- [ ] **Step 3: Add a shared issue-and-send helper**

In `apps/api/src/routes/auth.ts`, inside `registerAuthRoutes` (so it closes over `deps`), add:

```ts
  /**
   * Issues a verification token, mails it, and records the request. Best-effort by design:
   * an SMTP outage must not block registration, so a send failure is logged and swallowed
   * while the token stays valid for a later resend.
   */
  async function sendVerification(
    user: { id: string; email: string },
    req: FastifyRequest,
  ): Promise<void> {
    const { token, hash } = generateToken('qv');
    await createAuthToken(deps.pool, {
      userId: user.id,
      purpose: 'email_verify',
      tokenHash: hash,
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });
    await appendAuditEvent(deps.pool, {
      ...requestFacts(req),
      actorKind: 'user',
      actorUserId: user.id,
      actorLabel: user.email,
      action: 'auth.email_verify_requested',
      targetType: 'user',
      targetId: user.id,
    });
    try {
      await deps.mailSender.send(verifyEmailMessage(user.email, deps.appUrl, token));
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'verification email could not be sent');
    }
  }
```

Add `FastifyRequest` to the fastify type import, and add `createAuthToken`, `consumeAuthToken`,
`EMAIL_VERIFY_TTL_MS`, `markEmailVerified`, `generateToken` to the `@xperiment/db` import plus
`verifyEmailMessage` from `../mail/messages.js`.

- [ ] **Step 4: Call it from register**

In the register handler, after the existing `auth.register` audit call:

```ts
    await sendVerification(user, req);
```

- [ ] **Step 5: Add the two routes**

```ts
  const tokenSchema = z.object({ token: z.string().min(1).max(200) }).strict();

  app.post('/v1/auth/verify-email', async (req, reply) => {
    const parsed = tokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid or expired token');
    const claimed = await consumeAuthToken(deps.pool, hashToken(parsed.data.token), 'email_verify');
    // One message for unknown, expired, consumed and wrong-purpose alike: telling them
    // apart would say which of a stolen batch is still live.
    if (!claimed) return sendProblem(reply, 400, 'Invalid or expired token');
    await markEmailVerified(deps.pool, claimed.userId);
    await appendAuditEvent(deps.pool, {
      ...requestFacts(req),
      actorKind: 'user',
      actorUserId: claimed.userId,
      action: 'auth.email_verified',
      targetType: 'user',
      targetId: claimed.userId,
    });
    return { verified: true };
  });

  app.post('/v1/auth/resend-verification', async (req, reply) => {
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no email to verify');
    // Keyed on userId, not email: the caller is already identified and sends no body.
    if (!limiter.check(`resend:${ctx.userId}:${req.ip}`)) {
      return sendProblem(reply, 429, 'Too many attempts', 'Try again in a minute');
    }
    const user = await getUserById(deps.pool, ctx.userId);
    if (!user) return sendProblem(reply, 400, 'Sessions only');
    if (user.emailVerifiedAt) return { verified: true };
    await sendVerification(user, req);
    return { verified: false };
  });
```

`getUserById` does not exist yet. Add it to `packages/db/src/repos/auth.ts` beside
`getUserByEmail`:

```ts
export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  const r = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return r.rowCount ? mapUser(r.rows[0] as Record<string, unknown>) : null;
}
```

- [ ] **Step 6: Add `emailVerified` to `me`**

Replace the `GET /v1/auth/me` body:

```ts
    const ctx = authOf(req);
    if (!ctx.userId) return sendProblem(reply, 400, 'Sessions only', 'API keys have no user profile');
    const [memberships, user] = await Promise.all([
      listMemberships(deps.pool, ctx.userId),
      getUserById(deps.pool, ctx.userId),
    ]);
    return {
      user: { id: ctx.userId },
      emailVerified: user?.emailVerifiedAt !== null && user?.emailVerifiedAt !== undefined,
      currentWorkspaceId: ctx.workspaceId,
      workspaces: memberships.map((m) => ({ id: m.workspaceId, name: m.name, role: m.role })),
    };
```

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @xperiment/api exec vitest run test/emailVerification.test.ts && pnpm --filter @xperiment/api test && pnpm --filter @xperiment/db test
```

Expected: PASS. If a pre-existing api test asserts the exact shape of the `me` response, add
`emailVerified` to its expectation rather than removing the field.

- [ ] **Step 8: Typecheck and commit**

```bash
pnpm --filter @xperiment/api typecheck && pnpm --filter @xperiment/db typecheck
git add apps/api/src/routes/auth.ts packages/db/src/repos/auth.ts apps/api/test/emailVerification.test.ts
git commit -m "feat: verify email addresses with a mailed single-use link"
```

---

### Task 4: Password reset

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Create: `apps/api/test/passwordReset.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3 plus `consumeOtherTokens`, `PASSWORD_RESET_TTL_MS`, `updatePassword`, `revokeAllSessions`, `hashPassword`, `getUserByEmail`, `withTx`, `passwordResetMessage`.
- Produces: `POST /v1/auth/forgot-password`, `POST /v1/auth/reset-password`. Actions `auth.password_reset_requested`, `auth.password_reset_completed`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/passwordReset.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { memoryMailSender, type MailMessage } from '../src/mail/sender.js';
import { buildServer } from '../src/server.js';

let pool: Pool;
let app: FastifyInstance;
let sent: MailMessage[];

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  const mail = memoryMailSender();
  sent = mail.sent;
  app = buildServer({
    pool,
    registry: createDefaultRegistry(),
    mailSender: mail.sender,
    appUrl: 'https://app.test',
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE audit_events CASCADE`);
  sent.length = 0;
});

async function newAccount(): Promise<{ email: string; token: string }> {
  const email = `r-${randomUUID()}@xperiment.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password-123' },
  });
  sent.length = 0; // drop the verification mail
  return { email, token: res.json<{ token: string }>().token };
}

/** Runs forgot-password and returns the raw reset token from the mail. */
async function requestReset(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload: { email } });
  expect(res.statusCode).toBe(200);
  const mail = sent.find((m) => m.to === email);
  expect(mail, 'a known address should be mailed').toBeDefined();
  return /token=([^\s]+)/.exec(mail!.text)![1]!;
}

describe('forgot-password', () => {
  test('an unknown address gets the same 200, sends nothing and emits nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: `ghost-${randomUUID()}@xperiment.test` },
    });
    // A 404 here would turn the endpoint into a membership oracle.
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(0);
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.password_reset_requested'`,
    );
    expect(rows.rows[0]!.c).toBe('0');
  });

  test('a known address is mailed a link and the request is audited', async () => {
    const { email } = await newAccount();
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const token = await requestReset(email);
    expect(token.startsWith('qr_')).toBe(true);
    const rows = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action = 'auth.password_reset_requested'`,
    );
    expect(rows.rows[0]!.c).toBe('1');
  });
});

describe('reset-password', () => {
  test('sets the new password and lets the user log in with it', async () => {
    const { email } = await newAccount();
    const token = await requestReset(email);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'brand-new-456' },
    });
    expect(res.statusCode).toBe(200);
    const good = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'brand-new-456' },
    });
    expect(good.statusCode).toBe(200);
    const old = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password-123' },
    });
    expect(old.statusCode).toBe(401);
  });

  test('every existing session stops working', async () => {
    // Without this an attacker holding a stolen session keeps it after the victim resets,
    // which makes the whole reset theatre.
    const { email, token: session } = await newAccount();
    const before = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(before.statusCode).toBe(200);
    const reset = await requestReset(email);
    await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token: reset, password: 'another-789' } });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(after.statusCode).toBe(401);
  });

  test('a second use of the same reset link is a generic 400', async () => {
    const { email } = await newAccount();
    const token = await requestReset(email);
    await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'first-pass-1' } });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, password: 'second-pass-2' },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json<{ title: string }>().title).toBe('Invalid or expired token');
  });

  test('an earlier outstanding reset link is burnt by a later completed reset', async () => {
    const { email } = await newAccount();
    const first = await requestReset(email);
    sent.length = 0;
    const second = await requestReset(email);
    await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token: second, password: 'winner-111' } });
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: first, password: 'loser-222' },
    });
    expect(stale.statusCode).toBe(400);
  });

  test('a verification token cannot be used to reset a password', async () => {
    const email = `x-${randomUUID()}@xperiment.test`;
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'password-123' } });
    const verifyToken = /token=([^\s]+)/.exec(sent.find((m) => m.to === email)!.text)![1]!;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: verifyToken, password: 'hijacked-333' },
    });
    expect(res.statusCode).toBe(400);
    // …and the original password still works.
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'password-123' } });
    expect(login.statusCode).toBe(200);
  });

  test('a short password is refused before the token is spent', async () => {
    const { email } = await newAccount();
    const token = await requestReset(email);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'short' } }))
        .statusCode,
    ).toBe(400);
    // The token survives, so a typo does not cost the user their only link.
    expect(
      (await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'long-enough-9' } }))
        .statusCode,
    ).toBe(200);
  });

  test('completion is audited and no row carries the raw token', async () => {
    const { email } = await newAccount();
    await pool.query(`TRUNCATE audit_events CASCADE`);
    const token = await requestReset(email);
    await app.inject({ method: 'POST', url: '/v1/auth/reset-password', payload: { token, password: 'audited-444' } });
    const rows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action LIKE 'auth.password_reset%' ORDER BY id`,
    );
    expect(rows.rows.map((r) => r.action)).toEqual([
      'auth.password_reset_requested',
      'auth.password_reset_completed',
    ]);
    const leak = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE metadata::text LIKE '%' || $1 || '%'`,
      [token],
    );
    expect(leak.rows[0]!.c).toBe('0');

    const scoped = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM audit_events WHERE action LIKE 'auth.%' AND workspace_id IS NOT NULL`,
    );
    // Account-level events pre-date any workspace context, and §7 of the P design relies on
    // a null workspace to keep them out of every workspace's audit view. The emission code
    // simply omits workspaceId, so without this a later edit adding one would go unnoticed.
    expect(scoped.rows[0]!.c).toBe('0');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @xperiment/api exec vitest run test/passwordReset.test.ts
```

Expected: FAIL — 404 on `/v1/auth/forgot-password`.

- [ ] **Step 3: Add both routes**

In `apps/api/src/routes/auth.ts`:

```ts
  app.post('/v1/auth/forgot-password', async (req, reply) => {
    const parsed = z.object({ email: z.string().email() }).strict().safeParse(req.body ?? {});
    // Even a malformed body gets the neutral answer, so probing tells the caller nothing.
    if (!parsed.success) return reply.status(200).send({ sent: true });
    if (!limiter.check(`forgot:${parsed.data.email}:${req.ip}`)) {
      return sendProblem(reply, 429, 'Too many attempts', 'Try again in a minute');
    }
    const user = await getUserByEmail(deps.pool, parsed.data.email);
    if (user) {
      const { token, hash } = generateToken('qr');
      await createAuthToken(deps.pool, {
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: hash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      });
      await appendAuditEvent(deps.pool, {
        ...requestFacts(req),
        actorKind: 'user',
        actorUserId: user.id,
        actorLabel: user.email,
        action: 'auth.password_reset_requested',
        targetType: 'user',
        targetId: user.id,
      });
      try {
        await deps.mailSender.send(passwordResetMessage(user.email, deps.appUrl, token));
      } catch (e) {
        // Still 200: a send failure must neither leak existence nor 500.
        req.log.warn({ err: (e as Error).message }, 'password reset email could not be sent');
      }
    }
    // Identical response whether or not the address exists.
    return reply.status(200).send({ sent: true });
  });

  app.post('/v1/auth/reset-password', async (req, reply) => {
    const parsed = z
      .object({ token: z.string().min(1).max(200), password: z.string().min(8) })
      .strict()
      .safeParse(req.body ?? {});
    // Validated before the token is spent, so a too-short password does not burn the
    // user's only link.
    if (!parsed.success) return sendProblem(reply, 400, 'Invalid request body', parsed.error.message);
    const passwordHash = await hashPassword(parsed.data.password);
    const userId = await withTx(deps.pool, async (client) => {
      const claimed = await consumeAuthToken(client, hashToken(parsed.data.token), 'password_reset');
      if (!claimed) return null;
      await updatePassword(client, claimed.userId, passwordHash);
      // A stolen session must not survive the reset.
      await revokeAllSessions(client, claimed.userId);
      // Any other live reset link is now stale.
      await consumeOtherTokens(client, claimed.userId, 'password_reset');
      await appendAuditEvent(client, {
        ...requestFacts(req),
        actorKind: 'user',
        actorUserId: claimed.userId,
        action: 'auth.password_reset_completed',
        targetType: 'user',
        targetId: claimed.userId,
      });
      return claimed.userId;
    });
    if (!userId) return sendProblem(reply, 400, 'Invalid or expired token');
    return { reset: true };
  });
```

Add `consumeOtherTokens`, `PASSWORD_RESET_TTL_MS`, `updatePassword`, `withTx` to the
`@xperiment/db` import and `passwordResetMessage` to the messages import.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @xperiment/api exec vitest run test/passwordReset.test.ts && pnpm --filter @xperiment/api test
```

Expected: PASS.

- [ ] **Step 5: Prove the session revocation is load-bearing**

Temporarily comment out the `revokeAllSessions` line and run:

```bash
pnpm --filter @xperiment/api exec vitest run test/passwordReset.test.ts -t "every existing session stops working"
```

Expected: FAIL — the pre-reset session still returns 200 from `/v1/auth/me`, meaning a
stolen session survives a password reset. Restore the line and re-run.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @xperiment/api typecheck
git add apps/api/src/routes/auth.ts apps/api/test/passwordReset.test.ts
git commit -m "feat: reset a forgotten password and revoke every session on success"
```

---

### Task 5: The three public pages and the banner

**Files:**
- Create: `apps/web/src/app/forgot-password/page.tsx`, `apps/web/src/app/reset-password/page.tsx`, `apps/web/src/app/verify-email/page.tsx`, `apps/web/src/components/shell/VerifyBanner.tsx`
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/app/(app)/layout.tsx`, `apps/web/src/components/auth/AuthForm.tsx`

**Interfaces:**
- Consumes: the four endpoints from Tasks 3 and 4; `me.emailVerified`.
- Produces: `ApiClient.forgotPassword`, `.resetPassword`, `.verifyEmail`, `.resendVerification`; `MeResponse.emailVerified`.

- [ ] **Step 1: Add the client methods**

In `apps/web/src/lib/api.ts`, beside the other auth methods:

```ts
  forgotPassword(email: string): Promise<{ sent: boolean }> {
    return this.request('POST', '/v1/auth/forgot-password', { body: { email } });
  }

  resetPassword(token: string, password: string): Promise<{ reset: boolean }> {
    return this.request('POST', '/v1/auth/reset-password', { body: { token, password } });
  }

  verifyEmail(token: string): Promise<{ verified: boolean }> {
    return this.request('POST', '/v1/auth/verify-email', { body: { token } });
  }

  resendVerification(): Promise<{ verified: boolean }> {
    return this.request('POST', '/v1/auth/resend-verification');
  }
```

Add `emailVerified: boolean;` to whichever interface types the `me` response (search for
`currentWorkspaceId` in that file — that interface is the one).

- [ ] **Step 2: Write `/forgot-password`**

Create `apps/web/src/app/forgot-password/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { TextField } from '../../components/ui/TextField';
import { getBrowserClient } from '../../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    // The endpoint answers identically for unknown addresses, and so must this page —
    // showing "no such account" here would undo the server's enumeration resistance.
    await getBrowserClient()
      .forgotPassword(email)
      .catch(() => undefined);
    setBusy(false);
    setDone(true);
  };

  return (
    <div className="q-auth" data-testid="forgot-password-page">
      <h1>Reset your password</h1>
      {done ? (
        <p data-testid="forgot-sent">
          If an account exists for {email}, a reset link is on its way. The link is valid for one hour.
        </p>
      ) : (
        <>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            data-testid="forgot-email"
          />
          <button
            className="q-btn"
            disabled={busy || email.length === 0}
            onClick={() => void submit()}
            data-testid="forgot-submit"
          >
            Send reset link
          </button>
        </>
      )}
      <p>
        <Link href="/login">Back to sign in</Link>
      </p>
    </div>
  );
}
```

If `TextField`'s props differ from `label`/`type`/`value`/`onChange`, match whatever
`AuthForm.tsx` passes it — do not change `TextField`.

- [ ] **Step 3: Write `/reset-password`**

Create `apps/web/src/app/reset-password/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { TextField } from '../../components/ui/TextField';
import { ApiError, getBrowserClient } from '../../lib/api';

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await getBrowserClient().resetPassword(token, password);
      router.replace('/login');
    } catch (e) {
      setError(e instanceof ApiError ? (e.detail ?? e.title) : 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <p data-testid="reset-no-token">
        This link is missing its token. Request a new one from <Link href="/forgot-password">reset your password</Link>.
      </p>
    );
  }

  return (
    <>
      {error ? (
        <div className="q-banner" data-testid="reset-error">
          {error}
        </div>
      ) : null}
      <TextField
        label="New password"
        type="password"
        value={password}
        onChange={setPassword}
        data-testid="reset-password"
      />
      <button
        className="q-btn"
        disabled={busy || password.length < 8}
        onClick={() => void submit()}
        data-testid="reset-submit"
      >
        Set new password
      </button>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="q-auth" data-testid="reset-password-page">
      <h1>Choose a new password</h1>
      {/* useSearchParams needs a Suspense boundary under the app router. */}
      <Suspense fallback={null}>
        <ResetForm />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 4: Write `/verify-email`**

Create `apps/web/src/app/verify-email/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { getBrowserClient } from '../../lib/api';

function VerifyRunner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');

  useEffect(() => {
    if (!token) {
      setState('failed');
      return;
    }
    getBrowserClient()
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch(() => setState('failed'));
  }, [token]);

  if (state === 'working') return <p data-testid="verify-working">Confirming your address…</p>;
  if (state === 'done') {
    return (
      <p data-testid="verify-done">
        Your email address is confirmed. <Link href="/login">Sign in</Link>.
      </p>
    );
  }
  return (
    <p data-testid="verify-failed">
      This link is invalid or has expired. Sign in and request a new one from the banner.
    </p>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="q-auth" data-testid="verify-email-page">
      <h1>Confirm your email</h1>
      <Suspense fallback={null}>
        <VerifyRunner />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 5: Write the banner**

Create `apps/web/src/components/shell/VerifyBanner.tsx`:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getBrowserClient } from '../../lib/api';

export function VerifyBanner() {
  const [resent, setResent] = useState(false);
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => getBrowserClient().me(), retry: false });

  if (!meQ.data || meQ.data.emailVerified) return null;

  return (
    <div className="q-banner" data-testid="verify-banner">
      Confirm your email address to secure your account.{' '}
      {resent ? (
        <span data-testid="verify-resent">Sent — check your inbox.</span>
      ) : (
        <button
          type="button"
          className="q-btn q-btn--ghost q-btn--sm"
          data-testid="verify-resend"
          onClick={() => {
            void getBrowserClient()
              .resendVerification()
              .catch(() => undefined)
              .finally(() => setResent(true));
          }}
        >
          Resend
        </button>
      )}
    </div>
  );
}
```

If the client's method for `GET /v1/auth/me` is not called `me()`, use the existing name —
search `api.ts` for `/v1/auth/me`.

- [ ] **Step 6: Mount the banner and link the page**

In `apps/web/src/app/(app)/layout.tsx`, import `VerifyBanner` and render it first in
`q-content`:

```tsx
          <VerifyBanner />
          <IncidentBanner />
          <QuotaBanner />
```

In `apps/web/src/components/auth/AuthForm.tsx`, add below the submit button, only for
login mode:

```tsx
      {mode === 'login' ? (
        <p>
          <Link href="/forgot-password" data-testid="forgot-link">
            Forgot your password?
          </Link>
        </p>
      ) : null}
```

- [ ] **Step 7: Typecheck and run the web suite**

```bash
pnpm --filter @xperiment/web typecheck && pnpm --filter @xperiment/web test
```

Expected: PASS. If `q-auth` is not the class the login page's wrapper uses, copy whatever
`AuthForm.tsx` renders as its outermost element.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "feat: add the password reset and email confirmation pages"
```

---

### Task 6: End-to-end journey and full verification

**Files:**
- Modify: `apps/web/e2e/web.spec.ts`, `.env.example`, `README.md`

- [ ] **Step 1: Document the configuration**

Append to `.env.example`:

```bash
# AUTH-002 platform mail. `log` writes messages to the server log and sends nothing —
# it is the dev default and MUST NOT be used in production, where it would print
# password-reset links into the logs. `smtp` requires SMTP_HOST and MAIL_FROM, and a
# missing one fails the boot rather than every reset.
MAIL_TRANSPORT=log
MAIL_FROM=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_SECURE=false

# Base URL the emailed links point at.
APP_URL=http://localhost:3005
```

Add to the README's Security section: that email verification is recorded but enforces
nothing, that a completed reset revokes every session, and that `MAIL_TRANSPORT=log` must
never run in production.

- [ ] **Step 2: Add the Playwright journey**

Append to `apps/web/e2e/web.spec.ts`. The stack is started by `e2e/setup.global.ts`, which
runs the api with the default `log` transport, so the browser cannot read the token — the
test reads it from the database instead, the same way other specs reach Postgres.

```ts
test('the reset pages render and validate their inputs', async ({ page }) => {
  await page.goto('/forgot-password');
  await expect(page.getByTestId('forgot-password-page')).toBeVisible();
  await page.getByTestId('forgot-email').fill(`nobody-${Date.now()}@xperiment.test`);
  await page.getByTestId('forgot-submit').click();
  // An unknown address gets the same neutral answer a known one does.
  await expect(page.getByTestId('forgot-sent')).toBeVisible();

  await page.goto('/reset-password');
  await expect(page.getByTestId('reset-no-token')).toBeVisible();

  await page.goto('/verify-email?token=qv_definitely-not-real');
  await expect(page.getByTestId('verify-failed')).toBeVisible();
});
```

If a later slice needs the full forgot → reset → login journey in the browser, it needs the
api started with a sender the test can read; the api-level test in Task 4 already covers
that path end to end.

- [ ] **Step 3: Run Playwright**

```bash
pnpm --filter @xperiment/web e2e
```

Expected: PASS, 9 specs.

- [ ] **Step 4: No secret material anywhere it should not be**

```bash
cd "<repo-root>" && docker exec postgres psql -U postgres -d xperiment -c "SELECT count(*) AS leaked FROM audit_events WHERE metadata::text ~* '(qv_|qr_)';"
```

Expected: `0`. A non-zero count means a route put a raw token in metadata.

```bash
cd "<repo-root>" && docker exec postgres psql -U postgres -d xperiment -c "SELECT count(*) AS plaintext FROM auth_tokens WHERE token_hash LIKE 'qv\_%' OR token_hash LIKE 'qr\_%';"
```

Expected: `0`. A non-zero count means a raw token was stored instead of its hash.

- [ ] **Step 5: Full gates**

```bash
pnpm test
```

Expected: every package green. **Not `pnpm -r test`.**

```bash
pnpm test:cov && pnpm -r typecheck && pnpm --filter @xperiment/e2e test
```

Expected: exit 0, no threshold failures, no type errors, 24 scenario tests.

Three e2e scenario tests — the failure-rate alert, the closed-period invoice, and the
seconds-cron schedule — are known to fail intermittently under full-suite load for reasons
unrelated to this slice; they are tracked separately. If they fail, re-run the e2e package
alone to confirm they pass in isolation before investigating.

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md apps/web/e2e
git commit -m "docs: document the mail transport and add the reset page journey"
```

---

## Self-Review

**1. Spec coverage.**

| Spec section | Task |
|---|---|
| §2 mailer, three senders, env validation, log hazard | 1 |
| §3 `auth_tokens`, hashing, TTLs, `generateToken` widening | 2 |
| §3 CAS with purpose, one generic 400 | 2 (repo), 3 and 4 (routes) |
| §4 register mails, verify-email, resend keyed on userId, `me.emailVerified` | 3 |
| §4 registration survives a mail failure | 3 |
| §5 forgot-password always 200, rate-limited, send failure still 200 | 4 |
| §5 reset consumes, updates, **revokes sessions**, burns other tokens, emits | 4 |
| §6 four audit actions, `workspace_id` null | 3 and 4 |
| §7 three public pages + banner | 5 |
| §8 testing, including the concurrency and session-revocation break-it checks | 2 Step 9, 4 Step 5 |

**One gap found and closed inline:** §6 requires all four actions to carry
`workspace_id: null`, but nothing asserted it — the emission code simply omits
`workspaceId`, which produces null, so a later edit adding one would go unnoticed and
account-level events would start leaking into workspace audit views. Task 4 Step 1's final
test now asserts no `auth.%` row carries a workspace.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every
code step carries its code. Five steps say "match what the existing file does" — for
`TextField`'s props, the auth wrapper class, the `me()` client method name, the `mapUser`
timestamp helper, and the nodemailer import style. Each names the file to read; they are
instructions to match real code, not deferred decisions.

**3. Type consistency.**

- `MailMessage { to, subject, text }` is identical in Tasks 1, 3 and 4.
- `MailSender.name` is `'log' | 'smtp' | 'memory'`; `createMailSenderFromEnv` only ever
  returns the first two, and `memoryMailSender` is constructed directly by tests.
- `consumeAuthToken(db, tokenHash, purpose)` returns `{ userId } | null` in Task 2 and is
  destructured as `claimed.userId` in Tasks 3 and 4.
- `AuthTokenPurpose` values `'email_verify'` / `'password_reset'` match the SQL CHECK
  constraint exactly.
- Token prefixes: `'qv'` is always paired with `'email_verify'` and `'qr'` with
  `'password_reset'`, in both the routes and the tests.
- `requestFacts(req)` already exists in `routes/auth.ts` from the P slice and returns the
  `requestId`/`ip`/`userAgent` fields `AuditEventInput` accepts, so the spreads in Tasks 3
  and 4 compile.
- `deps.appUrl` and `deps.mailSender` are added to `ResolvedServerDeps` in Task 1 before
  Tasks 3 and 4 read them.
