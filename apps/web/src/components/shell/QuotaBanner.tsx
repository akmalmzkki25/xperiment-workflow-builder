'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { getBrowserClient } from '../../lib/api';

/** Warns once any limit reaches its soft threshold; silent for a workspace in the clear. */
export function QuotaBanner() {
  const planQ = useQuery({
    queryKey: ['plan'],
    queryFn: () => getBrowserClient().getPlan(),
    retry: false,
    refetchInterval: 60_000,
  });
  const lines = planQ.data?.lines ?? [];
  const worst = lines.find((l) => l.status === 'blocked') ?? lines.find((l) => l.status === 'warn');
  if (!worst) return null;
  return (
    <div className={worst.status === 'blocked' ? 'q-banner' : 'q-banner q-banner--warn'} data-testid="quota-banner">
      <span>
        {worst.metric}: {worst.used} of {worst.limit} used this period.
      </span>
      <Button asChild variant="ghost" size="sm"><Link href="/plan">
        View plan
      </Link></Button>
    </div>
  );
}
