'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { getBrowserClient } from '../../lib/api';
import type { InvoiceSummary } from '../../lib/api';
import { forbiddenDetail } from '../../lib/permissions';
import { PermissionNotice } from '../common/PermissionNotice';

/** Whole rupiah, grouped — amounts are integers, so there is no decimal handling. */
function money(minor: number, currency: string): string {
  return `${currency} ${minor.toLocaleString('id-ID')}`;
}

const STATUS_COLOR: Record<InvoiceSummary['status'], string> = {
  issued: 'var(--color-amber)',
  paid: 'var(--color-jade)',
  void: 'var(--text-muted)',
};

export function InvoiceTable() {
  const qc = useQueryClient();
  const invoicesQ = useQuery({
    queryKey: ['invoices'],
    queryFn: () => getBrowserClient().listInvoices(),
    retry: false,
  });
  const settle = useMutation({
    mutationFn: (id: string) => getBrowserClient().markInvoicePaid(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const forbidden = forbiddenDetail(invoicesQ.error);
  if (forbidden) return <PermissionNotice detail={forbidden} />;
  if (invoicesQ.isLoading) return <p style={{ color: 'var(--text-muted)' }}>Loading invoices…</p>;

  const items = invoicesQ.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)' }} data-testid="invoices-empty">
        No invoices yet — the first one is issued when this billing period closes.
      </p>
    );
  }

  return (
    <table className="q-table" data-testid="invoice-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Plan</th>
          <th>Total</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((inv) => (
          <tr key={inv.id} data-testid={`invoice-${inv.id}`}>
            <td className="mono">{inv.periodStart}</td>
            <td>{inv.planCode}</td>
            <td className="mono">{money(inv.totalMinor, inv.currency)}</td>
            <td style={{ color: STATUS_COLOR[inv.status] }}>{inv.status}</td>
            <td>
              {inv.status === 'issued' ? (
                <Button variant="ghost" size="sm"
                  
                  disabled={settle.isPending}
                  onClick={() => settle.mutate(inv.id)}
                  data-testid={`settle-${inv.id}`}
                >
                  Mark paid
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
