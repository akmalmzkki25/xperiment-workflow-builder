'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useEffect, useState } from 'react';
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
  // Lower the dismiss high-water as alerts are acknowledged so a brand-new firing
  // after a dismiss-then-drain cycle re-shows the banner (rather than staying hidden
  // beneath a stale ceiling).
  useEffect(() => {
    if (count < dismissedCount) setDismissedCount(count);
  }, [count, dismissedCount]);

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
      <Button asChild variant="ghost" size="sm"><Link href="/alerts">
        View
      </Link></Button>
      <Button variant="ghost" size="sm"  style={{ marginLeft: 'auto' }} onClick={() => setDismissedCount(count)}>
        Dismiss
      </Button>
    </div>
  );
}
