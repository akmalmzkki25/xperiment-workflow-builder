ALTER TABLE workflows ADD COLUMN active BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE workflow_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  route_key TEXT NOT NULL UNIQUE,
  auth_mode TEXT NULL,
  secret_encrypted BYTEA NULL,
  idempotency_key_path TEXT NULL,
  cron TEXT NULL,
  timezone TEXT NULL,
  next_fire_at TIMESTAMPTZ NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, node_id)
);
CREATE INDEX idx_workflow_triggers_due
  ON workflow_triggers (next_fire_at) WHERE active AND type = 'schedule';
