'use client';

import { useQuery } from '@tanstack/react-query';
import { NativeSelect } from '@/components/common/NativeSelect';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { getBrowserClient, type AuditEvent } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

const PAGE = 50;

/**
 * Privilege and credential-lifecycle actions first, then the high-volume worker one.
 * credential.read_use emits a row per node per execution, so on a busy workspace it
 * dominates the unfiltered list — the filter is how you get past it. The default view is
 * deliberately unfiltered: an audit log that silently omits rows is worse than a noisy one.
 */
const ACTIONS = [
  'member.role_change',
  'api_key.create',
  'api_key.revoke',
  'invite.create',
  'invite.accept',
  'plan.change',
  'invoice.pay',
  'invoice.mark_paid',
  'workspace.create',
  'credential.create',
  'credential.delete',
  'credential.test',
  'trigger_secret.reveal',
  'secret.rekey_batch',
  'auth.register',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.logout',
  'auth.logout_all',
  'credential.read_use',
] as const;

function actorOf(e: AuditEvent): string {
  if (e.actorEmail) return e.actorEmail;
  if (e.actorApiKeyName) return `${e.actorApiKeyName} (api key)`;
  if (e.actorLabel) return e.actorLabel;
  return e.actorKind;
}

function targetOf(e: AuditEvent): string {
  if (!e.targetType) return '—';
  return e.targetId ? `${e.targetType} ${e.targetId.slice(0, 8)}` : e.targetType;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  // Cursors already followed. The last one is the page currently shown.
  const [pages, setPages] = useState<string[]>([]);

  const before = pages[pages.length - 1];
  const auditQ = useQuery({
    queryKey: ['audit', action, before ?? ''],
    queryFn: () =>
      getBrowserClient().listAudit({
        limit: PAGE,
        ...(before ? { before } : {}),
        ...(action ? { action } : {}),
      }),
    retry: false,
  });

  const forbidden = forbiddenDetail(auditQ.error);

  return (
    <div data-testid="audit-page">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>Audit</h1>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : (
        <>
          <div style={{ marginBottom: '1rem' }}>
            <NativeSelect
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setPages([]); // a new filter starts a new pagination run
              }}
              data-testid="audit-action-filter"
              aria-label="Filter by action"
            >
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </NativeSelect>
          </div>

          {auditQ.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : null}
          {auditQ.isError && !forbidden ? <Alert className="flex flex-wrap items-center gap-3">Could not load the audit log.</Alert> : null}

          {auditQ.data ? (
            auditQ.data.items.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }} data-testid="audit-empty">
                No events recorded yet.
              </p>
            ) : (
              <>
                <Table data-testid="audit-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Outcome</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditQ.data.items.map((e) => (
                      <TableRow key={e.id} data-testid={`audit-${e.id}`}>
                        <TableCell style={{ color: 'var(--text-secondary)' }}>{fmtTime(e.createdAt)}</TableCell>
                        <TableCell>{actorOf(e)}</TableCell>
                        <TableCell>{e.action}</TableCell>
                        <TableCell style={{ color: 'var(--text-secondary)' }}>{targetOf(e)}</TableCell>
                        <TableCell>{e.outcome}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {auditQ.data.nextBefore ? (
                  <Button
                    type="button"
                    
                    style={{ marginTop: '1rem' }}
                    onClick={() => setPages((p) => [...p, auditQ.data!.nextBefore!])}
                    data-testid="audit-load-more"
                  >
                    Load more
                  </Button>
                ) : null}
              </>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
