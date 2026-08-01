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
