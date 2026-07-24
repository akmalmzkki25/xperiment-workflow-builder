CREATE TABLE usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  metric        TEXT NOT NULL,
  quantity      BIGINT NOT NULL,
  execution_id  UUID NULL,
  workflow_id   UUID NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_events_workspace ON usage_events (workspace_id, occurred_at DESC);
