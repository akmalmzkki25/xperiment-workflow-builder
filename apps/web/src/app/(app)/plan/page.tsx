'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { InvoiceTable } from '../../../components/plan/InvoiceTable';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { ApiError, getBrowserClient } from '../../../lib/api';
import type { PlanSnapshot, QuotaLineView } from '../../../lib/api';
import { fmtCount } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

const PLAN_CODES = ['free', 'builder', 'team', 'business'] as const;

const LABELS: Record<QuotaLineView['metric'], string> = {
  executionsPerMonth: 'Executions this period',
  aiTokensPerMonth: 'AI tokens this period',
  activeWorkflows: 'Active workflows',
  members: 'Members',
};

const STATUS_COLOR: Record<QuotaLineView['status'], string> = {
  ok: 'var(--color-jade)',
  warn: 'var(--color-amber)',
  blocked: 'var(--color-coral)',
};

function Meter({ line }: { line: QuotaLineView }) {
  const pct = line.limit === null ? 0 : Math.min(100, Math.round((line.used / Math.max(line.limit, 1)) * 100));
  return (
    <tr data-testid={`quota-${line.metric}`}>
      <td>{LABELS[line.metric]}</td>
      <td className="mono" style={{ whiteSpace: 'nowrap' }}>
        {fmtCount(line.used)} / {line.limit === null ? '∞' : fmtCount(line.limit)}
      </td>
      <td style={{ width: '40%' }}>
        <div
          aria-hidden
          style={{ height: 8, borderRadius: 4, background: 'var(--surface-raised)', overflow: 'hidden' }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: STATUS_COLOR[line.status] }} />
        </div>
      </td>
      <td style={{ color: STATUS_COLOR[line.status] }}>{line.status}</td>
    </tr>
  );
}

export default function PlanPage() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const planQ = useQuery({ queryKey: ['plan'], queryFn: () => getBrowserClient().getPlan(), retry: false });

  const change = useMutation({
    mutationFn: (patch: { planCode?: string; allowOverage?: boolean }) => getBrowserClient().updatePlan(patch),
    onSuccess: () => {
      setError('');
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
    // Surfaces the 409 a downgrade below current usage returns.
    onError: (err: unknown) => setError(err instanceof ApiError ? (err.detail ?? err.title) : 'Could not change the plan'),
  });

  const forbidden = forbiddenDetail(planQ.error);
  const plan: PlanSnapshot | undefined = planQ.data;

  return (
    <div data-testid="plan-page">
      <div className="q-page-head">
        <h1>Plan</h1>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : (
        <>
          {error ? (
            <div className="q-banner" data-testid="plan-error">
              {error}
            </div>
          ) : null}
          {planQ.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading plan…</p> : null}
          {planQ.isError && !forbidden ? <div className="q-banner">Could not load the plan.</div> : null}

          {plan ? (
            <>
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-4)',
                  alignItems: 'center',
                  padding: 'var(--space-4)',
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-node)',
                  marginBottom: 'var(--space-6)',
                }}
              >
                <label className="q-field__hint">
                  Plan
                  <select
                    className="q-select"
                    value={plan.planCode}
                    disabled={change.isPending}
                    onChange={(e) => change.mutate({ planCode: e.target.value })}
                    data-testid="plan-code"
                    aria-label="Plan"
                  >
                    {PLAN_CODES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="q-field__hint" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={plan.allowOverage}
                    disabled={change.isPending}
                    onChange={(e) => change.mutate({ allowOverage: e.target.checked })}
                    data-testid="plan-overage"
                  />
                  Allow overage — keep running past a limit and accrue billable usage
                </label>
              </div>

              <table className="q-table">
                <thead>
                  <tr>
                    <th>Limit</th>
                    <th>Used</th>
                    <th></th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.lines.map((l) => (
                    <Meter key={l.metric} line={l} />
                  ))}
                </tbody>
              </table>

              <p className="q-field__hint" style={{ marginTop: 'var(--space-3)' }}>
                Period-to-date usage counts executions from the moment they start; the Usage page reports runs that
                have finished, so a run in flight appears here first.
              </p>

              <h2 style={{ fontSize: 'var(--text-h2)', margin: 'var(--space-6) 0 var(--space-3)' }}>Invoices</h2>
              <InvoiceTable />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
