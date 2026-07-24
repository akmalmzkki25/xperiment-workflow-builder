'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { getBrowserClient } from '../../lib/api';

/**
 * Shows a dismissible incident banner while the workspace has unacknowledged
 * alert firings (MON-010). Dismissal records the current count; the banner
 * re-shows automatically once the unacknowledged count rises above it.
 */
export function IncidentBanner() {
  const [dismissedCount, setDismissedCount] = useState(0);
  const q = useQuery({
    queryKey: ['alert-events'],
    queryFn: () => getBrowserClient().listAlertEvents(),
    refetchInterval: 15000,
  });

  const count = q.data?.unacknowledged ?? 0;
  if (count === 0 || count <= dismissedCount) return null;

  return (
    <div
      role="status"
      data-testid="incident-banner"
      className="q-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        borderColor: 'var(--status-failed)',
        color: 'var(--status-failed)',
      }}
    >
      <span>
        ⚠ {count} unacknowledged alert{count === 1 ? '' : 's'}
      </span>
      <Link href="/alerts" className="q-btn q-btn--ghost q-btn--sm">
        View
      </Link>
      <button className="q-btn q-btn--ghost q-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setDismissedCount(count)}>
        Dismiss
      </button>
    </div>
  );
}
