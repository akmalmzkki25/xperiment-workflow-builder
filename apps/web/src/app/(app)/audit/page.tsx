'use client';

import { useQuery } from '@tanstack/react-query';
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
      <div className="q-page-head">
        <h1>Audit</h1>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : (
        <>
          <div style={{ marginBottom: '1rem' }}>
            <select
              className="q-select"
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
            </select>
          </div>

          {auditQ.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : null}
          {auditQ.isError && !forbidden ? <div className="q-banner">Could not load the audit log.</div> : null}

          {auditQ.data ? (
            auditQ.data.items.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }} data-testid="audit-empty">
                No events recorded yet.
              </p>
            ) : (
              <>
                <table className="q-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditQ.data.items.map((e) => (
                      <tr key={e.id} data-testid={`audit-${e.id}`}>
                        <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(e.createdAt)}</td>
                        <td>{actorOf(e)}</td>
                        <td>{e.action}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{targetOf(e)}</td>
                        <td>{e.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
