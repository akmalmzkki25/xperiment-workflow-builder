-- SEC-001: per-workspace key material. One row per workspace, holding that
-- workspace's KEK wrapped by the deployment's root key. Deleting the row makes every
-- secret in the workspace permanently undecryptable — that is the crypto-shredding
-- property WS-010 needs, so the CASCADE is intentional, not an oversight.
--
-- provider and root_key_id are recorded so a future rotation (SEC-007) can find every
-- KEK wrapped by a retired root key. P does not rotate; it makes rotation findable.
CREATE TABLE workspace_keys (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  root_key_id  TEXT NOT NULL,
  wrapped_key  BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at   TIMESTAMPTZ NULL
);

-- Out-of-band format discriminator. A legacy blob begins with a random 12-byte IV, so
-- an in-band marker byte would be ambiguous for roughly 1 in 256 rows. DEFAULT 0 is
-- what makes this migration safe on existing data; new rows pass 1 explicitly.
ALTER TABLE connections       ADD COLUMN enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE workflow_triggers ADD COLUMN secret_enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE workflows         ADD COLUMN completion_webhook_enc_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE alert_rules       ADD COLUMN webhook_secret_enc_version SMALLINT NOT NULL DEFAULT 0;

-- SEC-009. Replaces auth_events as the write target; auth_events stays in place as
-- historical data. workspace_id is nullable because a failed login for an unrecognised
-- email belongs to no workspace — and GET /v1/audit must never return those rows.
CREATE TABLE audit_events (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     UUID NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('user','api_key','system','anonymous')),
  -- SET NULL, not CASCADE: deleting a user must not delete the record of what they
  -- did. actor_label retains the email for that case, and for anonymous attempts.
  actor_user_id    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_api_key_id UUID NULL REFERENCES api_keys(id) ON DELETE SET NULL,
  actor_label      TEXT NULL,
  action           TEXT NOT NULL,
  target_type      TEXT NULL,
  -- TEXT, not UUID: a trigger target is identified by IR node id.
  target_id        TEXT NULL,
  outcome          TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id       TEXT NULL,
  ip               TEXT NULL,
  user_agent       TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ordering and pagination are on id, not created_at: created_at defaults to now(),
-- which is transaction start time, so a long transaction can commit a row with an
-- earlier created_at than one already visible. BIGSERIAL is monotonic in insert order.
CREATE INDEX idx_audit_events_ws ON audit_events (workspace_id, id DESC);
CREATE INDEX idx_audit_events_target ON audit_events (workspace_id, target_type, target_id, id DESC);
