-- The AI builder becomes a conversation, so the conversation has to live somewhere.
--
-- Xperiment's own tables rather than @mastra/pg's PostgresStore, for four reasons that are all
-- load-bearing:
--
--   * PostgresStore creates its tables on first use, outside runMigrations' advisory lock
--     and outside schema_migrations, so `pnpm migrate` would stop reproducing the schema.
--   * Its resource_id is free text rather than a foreign key, so a transcript would not
--     cascade with the workspace and would not appear in the IDOR matrix that every other
--     tenant-scoped table is covered by.
--   * pruneExpired names its tables one at a time, so a table it does not know about is
--     kept forever — and this is the one new table likely to contain a credential
--     somebody pasted despite being told not to.
--   * workspace_keys' CASCADE is what makes crypto-shredding work at all; a transcript
--     that did not cascade would quietly punch a hole in it.

BEGIN;

CREATE TABLE agent_conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Nullable: an api-key caller has no user row. Mirrors audit_events.actor_user_id,
  -- including the SET NULL — deleting a user must not delete what they asked for.
  created_by   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  -- The workflow this conversation is building. NULL until create_workflow runs.
  -- SET NULL rather than CASCADE: deleting a workflow should not destroy the record of
  -- how it came to be specified.
  workflow_id  UUID NULL REFERENCES workflows(id) ON DELETE SET NULL,
  title        TEXT NOT NULL DEFAULT 'Untitled',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_conversations_ws ON agent_conversations (workspace_id, updated_at DESC);

CREATE TABLE agent_messages (
  -- BIGSERIAL for ordering and paging, not created_at. created_at defaults to now(),
  -- which is transaction start time, so a slow turn can commit a row that sorts before
  -- one already visible. The audit_events reasoning, applied again.
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  -- Denormalised deliberately. Every read is workspace-scoped, and joining to the parent
  -- on every page would make the tenancy predicate something a query could forget.
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- Visible text. Empty string for an assistant turn that only called tools.
  content         TEXT NOT NULL DEFAULT '',
  -- Tool calls for this turn, ALREADY REDACTED by appendAgentMessage. JSONB rather than a
  -- child table: written once, read whole, never queried by field.
  tool_calls      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Per-message counts, so a turn that fails still has a number to reconcile against the
  -- usage_events ledger.
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  model           TEXT NULL,
  -- A failed turn stays in the transcript. Somebody who asks a question and then sees
  -- nothing at all concludes the product is broken.
  outcome         TEXT NOT NULL DEFAULT 'ok'
                  CHECK (outcome IN ('ok', 'provider_error', 'quota_exceeded', 'cancelled', 'tool_limit', 'refused')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_messages_conversation ON agent_messages (conversation_id, id);
-- For the retention sweep, which dates by created_at.
CREATE INDEX idx_agent_messages_created_at ON agent_messages (created_at);

-- One row per time the agent asked for a credential. This is what turns "you need a
-- Telegram bot token" from a sentence in a transcript into a button, and what lets a
-- later turn tell whether the person went and did it.
--
-- Carries no payload and NO COLUMN CAPABLE OF HOLDING ONE. The raw secret goes from the
-- browser to POST /v1/connections and is sealed by the credentials vault there, exactly
-- as it is today. Nothing about this table changes that path.
CREATE TABLE agent_credential_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  workspace_id            UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_key           TEXT NOT NULL,
  -- An IR node id, so TEXT rather than UUID — same as audit_events.target_id.
  node_id                 TEXT NULL,
  reason                  TEXT NOT NULL DEFAULT '',
  fulfilled_connection_id UUID NULL REFERENCES connections(id) ON DELETE SET NULL,
  fulfilled_at            TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_credential_requests_conv ON agent_credential_requests (conversation_id, created_at);
-- Partial: only the unfulfilled ones are ever looked up, and they are the small set.
CREATE INDEX idx_agent_credential_requests_open
  ON agent_credential_requests (workspace_id, connector_key) WHERE fulfilled_at IS NULL;

COMMIT;
