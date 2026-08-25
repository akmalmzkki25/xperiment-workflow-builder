'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '../../../components/common/EmptyState';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { getBrowserClient, type ApprovalItem } from '../../../lib/api';
import { fmtTime, shortId } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const [comments, setComments] = useState<Record<string, string>>({});

  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: () => getBrowserClient().listApprovals(),
    refetchInterval: 5000,
    retry: false,
  });
  const forbidden = forbiddenDetail(approvals.error);

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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>Pending approvals</h1>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : approvals.isLoading ? (
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
                <Link href={`/executions/${item.executionId}`} className="font-mono text-[length:var(--text-small)] text-muted-foreground">
                  run {shortId(item.executionId)} · {item.nodeId}
                </Link>
              </div>
              <p className="text-[length:var(--text-small)] text-muted-foreground">Expires {fmtTime(item.expiresAt)}</p>
              <Textarea
                placeholder="Optional comment"
                value={comments[item.waitId] ?? ''}
                onChange={(e) => setComments((prev) => ({ ...prev, [item.waitId]: e.target.value }))}
                data-testid={`approval-comment-${item.nodeId}`}
                rows={2}
              />
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button variant="live" size="sm"
                  
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ item, decision: 'approve' })}
                  data-testid={`approve-${item.nodeId}`}
                >
                  Approve
                </Button>
                <Button variant="destructive" size="sm"
                  
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ item, decision: 'reject' })}
                  data-testid={`reject-${item.nodeId}`}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
