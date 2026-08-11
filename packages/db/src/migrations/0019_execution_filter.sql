-- Server-side filtering and keyset pagination for the executions list.
--
-- The list query is `WHERE workspace_id = $1 [AND workflow_id] [AND status = ANY(...)]
-- AND (created_at, id) < ($n, $m) ORDER BY created_at DESC, id DESC LIMIT k`.
--
-- `idx_executions_status (workspace_id, status)` could satisfy the status predicate but
-- carried no ordering, so every filtered page sorted the whole matching set before
-- taking twenty rows. On a workspace with a `*/5` cron that is the entire history.
--
-- Both indexes end in `id DESC` because the keyset compares the tuple `(created_at, id)`,
-- and a tie on created_at is not hypothetical: executions created in the same
-- transaction share it exactly.

CREATE INDEX IF NOT EXISTS idx_executions_ws_created
  ON executions (workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_executions_ws_status_created
  ON executions (workspace_id, status, created_at DESC, id DESC);

-- Redundant now: a strict prefix of the index above, so anything it served is still
-- served, and dropping it removes write cost from the hottest insert path in the system.
DROP INDEX IF EXISTS idx_executions_status;
