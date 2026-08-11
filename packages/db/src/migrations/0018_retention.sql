-- Indexes for the retention sweep.
--
-- Measured before writing: EVERY prune predicate seq-scanned, and still seq-scanned
-- with `enable_seqscan = off` under a 1e10 penalty — which proves no applicable index
-- existed rather than merely that the planner preferred a scan on small tables.
--
-- Two near-misses worth recording, because both look like support and are not:
--   * executions has (workflow_id, created_at DESC). With no bound on workflow_id a
--     filter on created_at can only FULL-SCAN that index, not seek it.
--   * task_outbox has (created_at) WHERE published_at IS NULL — the exact logical
--     COMPLEMENT of "prune the published ones", on a different column.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migration runner wraps each file in a
-- transaction and Postgres refuses CONCURRENTLY inside one. These tables are small
-- today; a deployment with real volume should build them by hand in a window first,
-- after which this migration finds them present and is a no-op.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_executions_created_at ON executions (created_at);
CREATE INDEX IF NOT EXISTS idx_execution_events_created_at ON execution_events (created_at);
CREATE INDEX IF NOT EXISTS idx_execution_waits_created_at ON execution_waits (created_at);

-- trigger_events dates by received_at. There is no created_at on this table at all, so
-- a prune written against created_at would raise 42703 rather than quietly do nothing.
CREATE INDEX IF NOT EXISTS idx_trigger_events_received_at ON trigger_events (received_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (created_at);

-- usage_events carries BOTH occurred_at (business time, caller-supplied, no default)
-- and created_at (insert time). Invoicing reads occurred_at, so retention must too —
-- pruning by insert time would delete a backfilled event that an invoice still counts.
CREATE INDEX IF NOT EXISTS idx_usage_events_occurred_at ON usage_events (occurred_at);

-- Partial, because only published rows are ever pruned and the unpublished ones are
-- the hot set the claim path walks.
CREATE INDEX IF NOT EXISTS idx_task_outbox_published_prune
  ON task_outbox (published_at) WHERE published_at IS NOT NULL;

COMMIT;
