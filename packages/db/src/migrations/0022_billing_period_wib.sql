-- Billing periods move from the UTC calendar month to Asia/Jakarta.
--
-- A rekey is not enough. Comparing `occurred_at >= period_start::date` cast the date
-- through the session TimeZone, so on a UTC session a run at 03:00 WIB on the 1st was
-- counted into the PREVIOUS month. The counters therefore have to be recomputed from
-- `usage_events`, which is the billing source of truth and is timestamptz, so nothing
-- was lost.
--
-- Two statements rather than one data-modifying CTE: a CTE that deletes while the main
-- statement upserts can touch the same row twice in one command, which is undefined.

-- 1. Wipe the counters that the ledger can still account for. Retention prunes
--    `usage_events` after a 365-day floor, so anything older than a workspace's earliest
--    surviving event cannot be recomputed — deleting those rows would silently zero the
--    historical quota of months that were invoiced a year ago. They keep their
--    UTC-derived values, which is the best available answer.
--
--    The horizon reaches ONE MONTH FURTHER BACK than the earliest surviving event,
--    because that is exactly how far the old bounds could misfile: an event in the first
--    seven WIB hours of month M was counted into M-1. Without this, a workspace whose
--    first ever run happened at 03:00 WIB on the 1st keeps a phantom row in M-1 *and*
--    gains the correct one in M — the same run counted twice against a live quota. The
--    cost is that a genuinely pruned M-1 row can be dropped; that is a year-old closed
--    period nobody reads, and a live double-count is the worse of the two.
DELETE FROM workspace_usage_counters c
USING (
  SELECT workspace_id,
         (date_trunc('month', min(occurred_at) AT TIME ZONE 'Asia/Jakarta')
            - INTERVAL '1 month')::date AS from_month
  FROM usage_events
  WHERE metric IN ('execution', 'ai_tokens')
  GROUP BY workspace_id
) h
WHERE c.workspace_id = h.workspace_id
  AND c.metric IN ('execution', 'ai_tokens')
  AND c.period_start >= h.from_month;

-- 2. Rebuild from the ledger, grouped by the WIB month the event actually happened in.
INSERT INTO workspace_usage_counters (workspace_id, period_start, metric, quantity)
SELECT e.workspace_id,
       date_trunc('month', e.occurred_at AT TIME ZONE 'Asia/Jakarta')::date,
       e.metric,
       SUM(e.quantity)
FROM usage_events e
WHERE e.metric IN ('execution', 'ai_tokens')
GROUP BY 1, 2, 3
ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET quantity = EXCLUDED.quantity;

-- Invoice rows are deliberately left alone. Their period labels are already the right
-- calendar months; only the amounts came from UTC-bounded counters, and rewriting a
-- closed invoice changes a record of money. The sweep is idempotent per
-- (workspace_id, period_start), so it will not re-issue them.
