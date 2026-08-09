-- Attribute a trigger event to the trigger node that received it.
--
-- A workflow may hold several trigger nodes, but trigger_events only ever recorded the
-- workflow. The sample-payload endpoint therefore validated its :nodeId and then ignored
-- it, showing every trigger the last five payloads of the whole workflow — one webhook's
-- data under another webhook's panel.
--
-- Nullable with no backfill: rows written before this migration cannot be attributed to
-- a node after the fact, and inventing an attribution would be worse than admitting the
-- gap. Those rows simply stop appearing as samples.
BEGIN;

ALTER TABLE trigger_events ADD COLUMN node_id TEXT;

-- The sample query filters by workflow, node and recency together.
CREATE INDEX idx_trigger_events_workflow_node
  ON trigger_events (workflow_id, node_id, received_at DESC);

COMMIT;
