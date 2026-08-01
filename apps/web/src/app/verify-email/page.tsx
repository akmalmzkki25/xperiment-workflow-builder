'use client';

import Link from 'next/link';
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
    <main className="q-auth" data-testid="verify-email-page">
      <div className="q-auth__card">
        <div>
          <div className="q-wordmark">Xperiment</div>
          <p className="q-auth__tagline" style={{ marginTop: 4 }}>
            Confirm your email.
          </p>
        </div>
        <Suspense fallback={null}>
          <VerifyRunner />
        </Suspense>
      </div>
    </main>
  );
}
