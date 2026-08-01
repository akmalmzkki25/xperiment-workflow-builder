-- AUTH-004. The secret is account-level, so it is wrapped by the deployment root key
-- rather than a workspace KEK: filing it under one workspace would mean destroying that
-- workspace's key locks the user out of every other workspace they belong to.
CREATE TABLE user_mfa (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc     BYTEA NOT NULL,
  -- Which root key wrapped it. A deployment pointed at the wrong key then fails loudly
  -- instead of silently rejecting every correct code.
  root_key_id    TEXT NOT NULL,
  -- NULL means enrolment was started but never proven. Such a row is not a second factor
  -- and no login consults it.
  confirmed_at   TIMESTAMPTZ NULL,
  -- Highest TOTP step already spent. The verification window is +/-1 step, so a code is
  -- live for 90 seconds; without this floor, a code seen once can be spent again inside it.
  last_used_step BIGINT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Hashed with the same sha256 as sessions, api keys and auth tokens. The raw code is
  -- shown to the user exactly once and never stored.
  code_hash   TEXT NOT NULL UNIQUE,
  consumed_at TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

-- Owner-set policy. Enforced against sessions only; see the 4B design for why API keys
-- are deliberately outside it.
ALTER TABLE workspaces ADD COLUMN require_mfa BOOLEAN NOT NULL DEFAULT false;

-- 0013 pinned the purpose CHECK to two values. The login challenge is a third, and this
-- constraint would otherwise reject every one of them at runtime rather than at migrate
-- time. Postgres named the inline constraint auth_tokens_purpose_check.
ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check
  CHECK (purpose IN ('email_verify','password_reset','mfa_challenge'));
