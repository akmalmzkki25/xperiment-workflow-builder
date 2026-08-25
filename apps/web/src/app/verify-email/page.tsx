'use client';

import Link from 'next/link';
import { Wordmark } from '@/components/common/Wordmark';
import { Card } from '@/components/ui/card';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { getBrowserClient } from '../../lib/api';

function VerifyRunner() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');

  useEffect(() => {
    if (!token) {
      setState('failed');
      return;
    }
    void getBrowserClient()
      .verifyEmail(token)
      .then(() => setState('done'))
      // Unknown, expired, consumed and wrong-purpose all arrive here as one 400, exactly
      // as the API intends — this page must not try to tell them apart either.
      .catch(() => setState('failed'));
  }, [token]);

  if (state === 'working') return <p data-testid="verify-working">Confirming your address…</p>;
  if (state === 'done') {
    return (
      <p data-testid="verify-done">
        Your email address is confirmed. <Link href="/login">Sign in</Link>.
      </p>
    );
  }
  return (
    <p data-testid="verify-failed">
      This link is invalid or has expired. Sign in and request a new one from the banner.
    </p>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--color-lontar)] p-8" data-testid="verify-email-page">
      <Card className="flex w-[min(400px,100%)] flex-col gap-6 rounded-[14px] p-10">
        <div>
          <Wordmark />
          <p className="mt-1 text-secondary-foreground">
            Confirm your email.
          </p>
        </div>
        <Suspense fallback={null}>
          <VerifyRunner />
        </Suspense>
      </Card>
    </main>
  );
}
