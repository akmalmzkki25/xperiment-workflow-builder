CREATE TABLE workspace_plans (
  workspace_id    UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_code       TEXT NOT NULL DEFAULT 'free',
  limit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  allow_overage   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_plans_code_check CHECK (plan_code IN ('free','builder','team','business'))
);

CREATE TABLE workspace_usage_counters (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  metric       TEXT NOT NULL,
  quantity     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period_start, metric),
  CONSTRAINT workspace_usage_counters_metric_check CHECK (metric IN ('execution','ai_tokens'))
);

ALTER TABLE alert_rules ADD COLUMN managed BOOLEAN NOT NULL DEFAULT false;

-- Existing workspaces land on free rather than unlimited.
INSERT INTO workspace_plans (workspace_id) SELECT id FROM workspaces
  ON CONFLICT (workspace_id) DO NOTHING;

-- One managed quota rule per workspace, so the soft limit rides Phase 2J's
-- cooldown, ack, and signed-webhook delivery instead of duplicating them.
INSERT INTO alert_rules (workspace_id, name, type, params, managed, cooldown_minutes)
SELECT w.id, 'Plan quota', 'quota', '{}'::jsonb, true, 720
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM alert_rules r WHERE r.workspace_id = w.id AND r.managed);
