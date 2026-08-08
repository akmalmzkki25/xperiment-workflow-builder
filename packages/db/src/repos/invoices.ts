import { CURRENCY, type InvoiceDraft, type InvoiceLineKind, type PlanCode } from '@xperiment/plans';
import type pg from 'pg';
import { type Db } from '../pool.js';
import { withTx } from '../tx.js';

export type InvoiceStatus = 'issued' | 'paid' | 'void';

export interface InvoiceRow {
  id: string;
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  planCode: string;
  currency: string;
  subtotalMinor: number;
  taxRateBps: number;
  taxMinor: number;
  totalMinor: number;
  status: InvoiceStatus;
  provider: string | null;
  providerRef: string | null;
  issuedAt: string;
  paidAt: string | null;
}

export interface InvoiceLineRow {
  id: string;
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  amountMinor: number;
}

const ts = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : (v as string | null));

/**
 * A DATE column is a calendar date, not an instant, but node-postgres parses one into a
 * Date at *local* midnight. Reading UTC components would therefore roll back a day east
 * of Greenwich (UTC+7 turns 2026-06-01 into 2026-05-31), so the local components are
 * what actually spell the stored date.
 */
const day = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/**
 * Bind a period boundary as a bare `YYYY-MM-DD` string rather than a Date, so Postgres
 * never casts an instant through the session timezone — west of Greenwich that would
 * store the previous day. Period boundaries are built with `Date.UTC`, so the UTC
 * components are the intended calendar date.
 */
const dateParam = (d: Date): string => d.toISOString().slice(0, 10);

function mapInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    id: r['id'] as string,
    workspaceId: r['workspace_id'] as string,
    periodStart: day(r['period_start']),
    periodEnd: day(r['period_end']),
    planCode: r['plan_code'] as string,
    currency: r['currency'] as string,
    subtotalMinor: Number(r['subtotal_minor']),
    taxRateBps: Number(r['tax_rate_bps']),
    taxMinor: Number(r['tax_minor']),
    totalMinor: Number(r['total_minor']),
    status: r['status'] as InvoiceStatus,
    provider: (r['provider'] as string | null) ?? null,
    providerRef: (r['provider_ref'] as string | null) ?? null,
    issuedAt: ts(r['issued_at'])!,
    paidAt: ts(r['paid_at']),
  };
}

function mapLine(r: Record<string, unknown>): InvoiceLineRow {
  return {
    id: r['id'] as string,
    kind: r['kind'] as InvoiceLineKind,
    description: r['description'] as string,
    quantity: Number(r['quantity']),
    unitPriceMinor: Number(r['unit_price_minor']),
    amountMinor: Number(r['amount_minor']),
  };
}

/**
 * Issue an invoice with its lines, atomically. Returns `null` when the period is already
 * invoiced: `UNIQUE (workspace_id, period_start)` makes the close sweep idempotent by
 * construction, so a duplicate is an ordinary outcome rather than an error.
 */
export async function issueInvoice(
  pool: pg.Pool,
  args: { workspaceId: string; periodStart: Date; periodEnd: Date; planCode: PlanCode; draft: InvoiceDraft },
): Promise<InvoiceRow | null> {
  try {
    return await withTx(pool, async (client) => {
      const r = await client.query(
        `INSERT INTO invoices
           (workspace_id, period_start, period_end, plan_code, currency,
            subtotal_minor, tax_rate_bps, tax_minor, total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          args.workspaceId,
          dateParam(args.periodStart),
          dateParam(args.periodEnd),
          args.planCode,
          CURRENCY,
          args.draft.subtotalMinor,
          args.draft.taxRateBps,
          args.draft.taxMinor,
          args.draft.totalMinor,
        ],
      );
      const invoice = mapInvoice(r.rows[0] as Record<string, unknown>);
      for (const l of args.draft.lines) {
        await client.query(
          `INSERT INTO invoice_lines (invoice_id, kind, description, quantity, unit_price_minor, amount_minor)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [invoice.id, l.kind, l.description, l.quantity, l.unitPriceMinor, l.amountMinor],
        );
      }
      return invoice;
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return null; // already invoiced
    throw e;
  }
}

export async function listInvoices(db: Db, workspaceId: string, limit: number): Promise<InvoiceRow[]> {
  const r = await db.query(`SELECT * FROM invoices WHERE workspace_id = $1 ORDER BY period_start DESC LIMIT $2`, [
    workspaceId,
    Math.min(Math.max(limit, 1), 100),
  ]);
  return (r.rows as Record<string, unknown>[]).map(mapInvoice);
}

export async function getInvoice(
  db: Db,
  id: string,
  workspaceId: string,
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const r = await db.query(`SELECT * FROM invoices WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (!r.rowCount) return null;
  const invoice = mapInvoice(r.rows[0] as Record<string, unknown>);
  const lines = await db.query(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id`, [id]);
  return { invoice, lines: (lines.rows as Record<string, unknown>[]).map(mapLine) };
}

/** Record which provider is collecting, without settling. */
export async function setInvoiceProvider(
  db: Db,
  args: { id: string; workspaceId: string; provider: string; providerRef: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE invoices SET provider = $3, provider_ref = $4
     WHERE id = $1 AND workspace_id = $2 AND status = 'issued'`,
    [args.id, args.workspaceId, args.provider, args.providerRef],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Compare-and-set from `issued` to `paid`. A replayed webhook or a double-clicked
 * button returns false and settles nothing — the same discipline the execution state
 * machine uses. There is deliberately no generic invoice update: status is the only
 * mutation this repo exposes, which is what keeps an issued invoice immutable.
 */
export async function markInvoicePaid(
  db: Db,
  args: { id: string; workspaceId: string; provider: string; providerRef: string },
): Promise<boolean> {
  const r = await db.query(
    `UPDATE invoices SET status = 'paid', paid_at = now(), provider = $3, provider_ref = $4
     WHERE id = $1 AND workspace_id = $2 AND status = 'issued'`,
    [args.id, args.workspaceId, args.provider, args.providerRef],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Workspaces whose closed period has no invoice yet.
 *
 * A workspace created at or after `period.end` did not exist during the period and must
 * not be billed for it — without that filter every new signup would receive a spurious
 * subscription charge for a month it was never a customer.
 *
 * Takes the period as one object rather than two dates so the pair cannot be passed in
 * the wrong order, which would silently invoice the wrong month.
 *
 * BOUNDED. Each workspace costs the caller about eight sequential round trips, so an
 * unbounded result set turns one scheduler tick into minutes of work with no visibility:
 * measured at ~138 workspaces/sec, an 11,800-row backlog took 86 seconds. The caller
 * drains the remainder on the next tick.
 */
export const DEFAULT_INVOICE_BATCH = 500;

export async function workspacesNeedingInvoice(
  db: Db,
  period: { start: Date; end: Date },
  limit: number = DEFAULT_INVOICE_BATCH,
): Promise<{ workspaceId: string }[]> {
  const r = await db.query(
    `SELECT w.id FROM workspaces w
     WHERE w.created_at < $2
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.workspace_id = w.id AND i.period_start = $1::date)
     ORDER BY w.created_at, w.id
     LIMIT $3`,
    [dateParam(period.start), period.end, limit],
  );
  return (r.rows as { id: string }[]).map((row) => ({ workspaceId: row.id }));
}
