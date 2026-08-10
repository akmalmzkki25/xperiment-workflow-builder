-- Make a replayed outbox row distinguishable from the original, and drop an index
-- column that measurement showed buys nothing.
--
-- BullMQ deduplicates on a custom job id and does so SILENTLY: a second add with an
-- existing id returns the existing job, never throws, and reports the caller's own
-- data back while Redis keeps the original. jobIdFor is deterministic over
-- executionId/nodeId/attempt, so a replayed dead letter reproduced the SAME id — and
-- within the removeOnComplete window (an hour) the replay was swallowed and the work
-- never ran, with nothing anywhere reporting it. Past the hour it ran. An operator
-- replaying a dead letter got behaviour that depended on how long they had waited.
--
-- The sequence lives on the ROW, not in the payload: the payload is what the worker
-- receives, and a dedup concern has no business changing it.
BEGIN;

ALTER TABLE task_outbox ADD COLUMN replay_seq INT NOT NULL DEFAULT 0;
ALTER TABLE outbox_dead_letters ADD COLUMN replay_seq INT NOT NULL DEFAULT 0;

-- 0016 added claimed_at to this index claiming it would let a stale claim be seen
-- without a heap fetch. That is not achievable: FOR UPDATE must pin the heap tuple to
-- take a row lock, which forecloses an index-only scan, and the OR in the predicate is
-- not range-indexable so claimed_at can only ever be a Filter. Measured head to head
-- the two shapes ran within 2% of each other while the wider index cost 37% more.
DROP INDEX IF EXISTS idx_task_outbox_claimable;
CREATE INDEX idx_task_outbox_claimable
  ON task_outbox (created_at)
  WHERE published_at IS NULL;

COMMIT;
