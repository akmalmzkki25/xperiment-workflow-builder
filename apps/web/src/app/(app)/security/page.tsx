'use client';

import { useQuery } from '@tanstack/react-query';
import { MfaPanel } from '../../../components/security/MfaPanel';
import { WorkspaceMfaPanel } from '../../../components/security/WorkspaceMfaPanel';
import { getBrowserClient } from '../../../lib/api';

export default function SecurityPage() {
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => getBrowserClient().me(), retry: false });
  const me = meQ.data;
  if (!me) return <p data-testid="security-loading">Loading…</p>;
  const current = me.workspaces.find((w) => w.id === me.currentWorkspaceId);
  return (
    <div data-testid="security-page">
      <div className="q-page-head">
        <h1>Security</h1>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <MfaPanel enabled={me.mfaEnabled} />
        {current ? (
          <WorkspaceMfaPanel role={current.role} requireMfa={current.requireMfa} selfEnrolled={me.mfaEnabled} />
        ) : null}
      </div>
    </div>
  );
}
