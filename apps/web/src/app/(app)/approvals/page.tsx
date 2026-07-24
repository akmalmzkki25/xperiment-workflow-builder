'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '../../../components/ui/EmptyState';
import { getBrowserClient, type ApprovalItem } from '../../../lib/api';
import { fmtTime, shortId } from '../../../lib/format';

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [comments, setComments] = useState<Record<string, string>>({});

  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: () => getBrowserClient().listApprovals(),
    refetchInterval: 5000,
  });

  const decide = useMutation({
    mutationFn: (args: { item: ApprovalItem; decision: 'approve' | 'reject' }) =>
      getBrowserClient().decideApproval(
        args.item.executionId,
        args.item.nodeId,
        args.decision,
        comments[args.item.waitId],
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });

  const items = approvals.data?.items ?? [];

  return (
    <>
      <div className="q-page-head">
        <h1>Pending approvals</h1>
      </div>

      {approvals.isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading approvals…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing awaiting approval"
          hint="When a workflow reaches a human-approval step, it appears here for a decision."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {items.map((item) => (
            <div className="q-trigger-panel" key={item.waitId} data-testid={`approvals-row-${item.nodeId}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <strong>{item.message ?? 'Approval requested'}</strong>
                <Link href={`/executions/${item.executionId}`} className="q-field__hint mono">
                  run {shortId(item.executionId)} · {item.nodeId}
                </Link>
              </div>
              <p className="q-field__hint">Expires {fmtTime(item.expiresAt)}</p>
              <textarea
                className="q-textarea"
                placeholder="Optional comment"
                value={comments[item.waitId] ?? ''}
                onChange={(e) => setComments((prev) => ({ ...prev, [item.waitId]: e.target.value }))}
                data-testid={`approval-comment-${item.nodeId}`}
                rows={2}
              />
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button
                  className="q-btn q-btn--live q-btn--sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ item, decision: 'approve' })}
                  data-testid={`approve-${item.nodeId}`}
                >
                  Approve
                </button>
                <button
                  className="q-btn q-btn--danger q-btn--sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ item, decision: 'reject' })}
                  data-testid={`reject-${item.nodeId}`}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
