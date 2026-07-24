CREATE TABLE execution_waits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  execution_id UUID NOT NULL REFERENCES executions(id),
  node_id TEXT NOT NULL,
  attempt INT NOT NULL,
  kind TEXT NOT NULL,               -- 'timer' | 'event' | 'approval'
  resume_token TEXT UNIQUE,         -- 24B base64url, for event/approval callbacks
  resume_at TIMESTAMPTZ,            -- timer waits: when to auto-resume
  expires_at TIMESTAMPTZ,           -- event/approval waits: deadline
  fallback TEXT,                    -- approval only: 'approve' | 'reject' | 'fail'
  message TEXT,                     -- approval prompt
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'expired'
  decision TEXT,                    -- approval: 'approve' | 'reject'
  resolved_by UUID REFERENCES users(id),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Scheduler sweep: due timers and expiries.
CREATE INDEX idx_waits_due_resume ON execution_waits (status, resume_at);
CREATE INDEX idx_waits_due_expiry ON execution_waits (status, expires_at);
-- Pending approvals list, per workspace.
CREATE INDEX idx_waits_workspace ON execution_waits (workspace_id, status, kind);
-- Watchdog / detail lookups by execution.
CREATE INDEX idx_waits_execution ON execution_waits (execution_id, status);
