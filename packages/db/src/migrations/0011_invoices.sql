CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  plan_code       TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'IDR',
  subtotal_minor  BIGINT NOT NULL,
  tax_rate_bps    INTEGER NOT NULL,
  tax_minor       BIGINT NOT NULL,
  total_minor     BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'issued',
  provider        TEXT NULL,
  provider_ref    TEXT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ NULL,
  CONSTRAINT invoices_status_check CHECK (status IN ('issued','paid','void')),
  CONSTRAINT invoices_period_unique UNIQUE (workspace_id, period_start)
);

CREATE TABLE invoice_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  description      TEXT NOT NULL,
  quantity         BIGINT NOT NULL,
  unit_price_minor BIGINT NOT NULL,
  amount_minor     BIGINT NOT NULL
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX idx_invoices_workspace ON invoices (workspace_id, period_start DESC);
