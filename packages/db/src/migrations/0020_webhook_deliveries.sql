-- Why a rejected webhook delivery has to leave a trace.
--
-- Until now the gateway answered 401 and recorded nothing. An operator whose provider is
-- signing under a header the trigger does not expect saw "my webhook isn't working" with
-- no evidence anywhere in the product, and the only way to diagnose it was to read the
-- gateway's stdout — which nobody running this has access to.
--
-- Two columns are deliberately ABSENT, and their absence is the design:
--
--   * the body. A rejected delivery is unauthenticated input. Storing it would let anyone
--     who knows a route key write arbitrary content into the database and onto an
--     operator's screen. Only its size is kept.
--   * header VALUES. `headers_seen` holds header NAMES only. "You sent x-xperiment-signature,
--     this trigger expects x-hub-signature-256" is the entire diagnostic, and it needs no
--     value — which is fortunate, because those values are signatures and bearer tokens.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger_id uuid NOT NULL REFERENCES workflow_triggers(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  mode text NOT NULL,
  outcome text NOT NULL,
  status_code smallint NOT NULL,
  -- What the trigger was configured to expect, recorded at delivery time so a later
  -- reconfiguration does not rewrite history.
  auth_mode text,
  headers_seen text[] NOT NULL DEFAULT '{}',
  body_bytes integer NOT NULL DEFAULT 0,
  -- SET NULL, not CASCADE: retention prunes executions long before deliveries, and a
  -- pruned run must not take its delivery record with it.
  execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- The panel reads the newest deliveries for one workflow.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_workflow
  ON webhook_deliveries (workflow_id, received_at DESC, id DESC);

-- Retention sweeps by age across every workspace.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
  ON webhook_deliveries (received_at);
