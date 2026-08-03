'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, getBrowserClient } from '../../lib/api';
import { PANEL } from './MfaPanel';

export function WorkspaceMfaPanel({
  role,
  requireMfa,
  selfEnrolled,
}: {
  role: string;
  requireMfa: boolean;
  selfEnrolled: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (role !== 'owner') return null;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await getBrowserClient().setMfaPolicy(!requireMfa);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the policy');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={PANEL} data-testid="workspace-mfa-panel">
      <h2 style={{ margin: 0 }}>Require two-factor for admins</h2>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
        Owners and admins in this workspace must have two-factor turned on before they can use it. Members with other
        roles are unaffected, and API keys are not covered.
      </p>
      {!selfEnrolled && !requireMfa ? (
        <p data-testid="policy-blocked" style={{ margin: 0 }}>
          Turn on your own two-factor first — otherwise this locks you out.
        </p>
      ) : null}
      <button
        className="q-btn"
        disabled={busy || (!selfEnrolled && !requireMfa)}
        onClick={() => void toggle()}
        data-testid="policy-toggle"
      >
        {requireMfa ? 'Stop requiring it' : 'Require it'}
      </button>
      {error ? (
        <div className="q-banner" data-testid="policy-error">
          {error}
        </div>
      ) : null}
    </section>
  );
}
