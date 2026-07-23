CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO workspaces (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  active_version_id UUID NULL,
  draft_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflows_workspace ON workflows (workspace_id, created_at DESC);

CREATE TABLE workflow_drafts (
  workflow_id UUID PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  definition_json JSONB NOT NULL,
  revision BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  definition_json JSONB NOT NULL,
  definition_hash TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version_number)
);

CREATE TABLE trigger_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'consumed',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, idempotency_key)
);

CREATE TABLE executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id),
  trigger_event_id UUID NULL REFERENCES trigger_events(id),
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'production',
  idempotency_key TEXT NULL,
  error_summary TEXT NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_executions_workflow ON executions (workflow_id, created_at DESC);
CREATE INDEX idx_executions_status ON executions (workspace_id, status);
CREATE INDEX idx_executions_trigger_event ON executions (trigger_event_id);

CREATE TABLE execution_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 1,
  input_json JSONB NULL,
  output_json JSONB NULL,
  output_port TEXT NULL,
  error_json JSONB NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  worker_id TEXT NULL,
  UNIQUE (execution_id, node_id, attempt)
);
CREATE INDEX idx_execution_nodes_execution ON execution_nodes (execution_id, node_id, attempt DESC);

CREATE TABLE execution_events (
  sequence BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  node_id TEXT NULL,
  payload_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_execution_events_execution ON execution_events (execution_id, sequence);

CREATE TABLE task_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  delay_ms INT NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_outbox_unpublished ON task_outbox (created_at) WHERE published_at IS NULL;
