-- Find the run that handled order INV-20260811-0042.
--
-- Until now an operator answering "the customer says their order never went through"
-- had to open runs one at a time. Status filtering does not help: the run they want
-- probably SUCCEEDED, and there are four hundred of those.
--
-- A trigram GIN index over the payload text, because the question is always a substring
-- — an order id, a phone number, an email — and never a JSON path the operator knows.
-- `jsonb_path_ops` containment would need them to type the shape.
--
-- MEASURED, and it sets the minimum query length the API enforces: at three characters
-- Postgres uses this index (Bitmap Index Scan); at two it cannot, because a trigram needs
-- three consecutive characters to exist, and falls back to a sequential scan over every
-- webhook body in the table. The minimum is not a nicety, it is the boundary at which
-- this index stops working.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Deliberately not partial and not per-workspace: the predicate is a substring, so there
-- is no useful subset to index. The workspace filter is applied on the recheck.
CREATE INDEX IF NOT EXISTS idx_trigger_events_payload_trgm
  ON trigger_events USING gin ((payload_json::text) gin_trgm_ops);
