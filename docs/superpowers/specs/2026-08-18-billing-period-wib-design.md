# Billing periods in WIB, not UTC — design

**Status:** approved for implementation (self-directed; supersedes the "Known defect"
section of the README, which asked for exactly this document).

## The defect, measured

`packages/plans` defines a period as the UTC calendar month. `workspace_usage_counters`
and `invoices` are keyed by it, and `usage_events` are folded into it by comparing a
`timestamptz` against a `date`:

```sql
occurred_at >= $2::date AND occurred_at < ($2::date + INTERVAL '1 month')
```

Measured against the live database:

```
SHOW TimeZone;                                              -> Etc/UTC
SELECT '2026-08-01'::date::timestamptz;                     -> 2026-08-01 00:00:00+00
SELECT '2026-08-01T03:00:00+07:00'::timestamptz
       >= '2026-08-01'::date;                               -> false
```

A run at **03:00 WIB on 1 August is counted into July.** For an Indonesian shop that is
the first seven hours of every month landing on the previous invoice, and the last seven
hours of every month landing on the next one. Scheduling, meanwhile, already defaults to
`Asia/Jakarta`, so the product disagrees with itself.

There is a second defect hiding in the same line: because the comparison casts a `date`
using the **session** `TimeZone`, the period boundary is not defined by the application
at all. The same code on a database configured `TimeZone=Asia/Jakarta` would already
bill differently. That is a correctness property that must not live in a server setting.

## Decisions

**One timezone constant, not a per-workspace setting.** `BILLING_TZ = 'Asia/Jakarta'`
in `@xperiment/plans`. The product is Indonesia-first and the scheduler already hardcodes the
same zone. A per-workspace billing timezone is a real feature — settings surface,
migration, per-row queries — and mixing it in would make this diff unreviewable. Noted as
a follow-up, not smuggled in.

**A period is a value with a key and two instants.** The bug exists because one `Date`
was doing two jobs: labelling a `DATE` column and bounding a `timestamptz` range. Those
are different values in any timezone but UTC.

```ts
export interface BillingPeriod {
  key: string;      // 'YYYY-MM-DD' — the DATE key of counters and invoices
  startsAt: Date;   // first instant of the month in BILLING_TZ
  endsAt: Date;     // first instant of the next month in BILLING_TZ
}
```

`periodStart` / `periodEnd` are **removed**, not deprecated: tsc then names every call
site, which is the only reliable way to find all of them.

**Range bounds are computed in SQL from the key**, never passed as a pre-cast instant:

```sql
occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Jakarta')
occurred_at <  (($2::date + INTERVAL '1 month') AT TIME ZONE 'Asia/Jakarta')
```

so the boundary cannot drift with the session `TimeZone`.

**The daily usage series groups in WIB too** (`date_trunc('day', occurred_at AT TIME ZONE
'Asia/Jakarta')`). A shop owner reading a bar per day must see their own days.

## Data migration — `0022_billing_period_wib.sql`

A rekey is not enough: a run at 03:00 WIB on 1 August was counted into July, so the
counters have to be **recomputed from the `usage_events` ledger**, which is the billing
source of truth and is `timestamptz`, so no information was lost.

Two statements, not one CTE — a data-modifying CTE and an `ON CONFLICT` in the same
statement can touch the same row twice, which is undefined:

1. **Delete** the `execution` and `ai_tokens` counter rows for every workspace period at
   or after that workspace's **earliest surviving ledger month**.
2. **Insert** the recomputed sums, grouped by `date_trunc('month', occurred_at AT TIME
   ZONE 'Asia/Jakarta')::date`.

The horizon matters: retention prunes `usage_events` after a 365-day floor, so counter
rows older than the ledger cannot be recomputed. Deleting those would silently zero
historical quota. Rows before the horizon keep their UTC-derived values — the best
available answer for a month that was invoiced a year ago.

**Existing invoice rows are left untouched.** Their period *labels* are already the right
calendar months; only the amounts were computed from UTC-bounded counters. Rewriting a
closed invoice is worse than leaving it: it changes a record of money. The sweep is
idempotent per `(workspace_id, period_start)`, so it will not re-issue. This is stated in
the README rather than silently absorbed.

## Verification

- A ledger event at 03:00 WIB on the 1st lands in that month's counter, not the previous.
- A ledger event at 23:00 WIB on the last day lands in that month, not the next.
- The boundary is identical with the session `TimeZone` set to `Etc/UTC` and to
  `Asia/Jakarta` — the application defines it, not the server.
- `workspacesNeedingInvoice` excludes a workspace created at 01:00 WIB on the 1st of the
  following month, which did not exist during the period.
- The migration moves an event that the old bounds had put in the wrong month.
