-- Lease outbox rows, and give a row that will never publish somewhere to go.
--
-- Every one of the five services runs its own publisher, and all five read the same
-- unclaimed rows every 250ms with no locking at all. Only BullMQ's jobId dedup keeps
-- that from being five times the work. A lease makes the claim exclusive.
--
-- `attempts` already existed but was only ever incremented on SUCCESS, so it could
-- never record a failure and nothing read it. It is now incremented at claim time,
-- which is what lets a row that keeps failing eventually stop being retried.
BEGIN;

ALTER TABLE task_outbox ADD COLUMN claimed_at TIMESTAMPTZ;
ALTER TABLE task_outbox ADD COLUMN last_error TEXT;

-- Serves the claim predicate directly: unpublished rows, oldest first, with the
-- lease column available so a stale claim is visible without a heap fetch.
DROP INDEX IF EXISTS idx_task_outbox_unpublished;
CREATE INDEX idx_task_outbox_claimable
  ON task_outbox (created_at, claimed_at)
  WHERE published_at IS NULL;

-- A row that cannot publish — an event type no queue maps, a payload the queue
-- rejects — is moved here rather than left to be re-read and re-logged every 250ms
-- by five processes forever while permanently occupying a slot in the batch.
CREATE TABLE outbox_dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  attempts INT NOT NULL,
  last_error TEXT NOT NULL,
  dead_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when an operator replays it. The replay writes a NEW outbox row rather than
  -- resurrecting this one, so the record of the failure survives the fix.
  replayed_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_outbox_dead_letters_open ON outbox_dead_letters (dead_at DESC) WHERE replayed_at IS NULL;

COMMIT;
