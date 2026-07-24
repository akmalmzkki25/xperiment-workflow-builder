CREATE TABLE alert_rules (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              UUID NOT NULL REFERENCES workspaces(id),
  name                      TEXT NOT NULL,
  type                      TEXT NOT NULL,
  params                    JSONB NOT NULL,
  webhook_url               TEXT NULL,
  webhook_secret_encrypted  BYTEA NULL,
  enabled                   BOOLEAN NOT NULL DEFAULT TRUE,
  cooldown_minutes          INTEGER NOT NULL DEFAULT 60,
  last_fired_at             TIMESTAMPTZ NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_rules_workspace ON alert_rules (workspace_id, created_at DESC);
CREATE INDEX idx_alert_rules_enabled ON alert_rules (enabled) WHERE enabled;

CREATE TABLE alert_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id),
  rule_id          UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  fired_at         TIMESTAMPTZ NOT NULL,
  detail           JSONB NOT NULL,
  acknowledged_at  TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_events_workspace ON alert_events (workspace_id, fired_at DESC);
