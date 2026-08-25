'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { TextField } from '../../components/common/TextField';
import { ApiError, getBrowserClient } from '../../lib/api';

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await getBrowserClient().resetPassword(token, password);
      // The reset revoked every session, so there is nothing to land in but the login page.
      router.replace('/login');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reset the password');
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <p data-testid="reset-no-token">
        This link is missing its token. Request a new one from <Link href="/forgot-password">reset your password</Link>.
      </p>
    );
  }

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField
        label="New password"
        type="password"
        value={password}
        onChange={setPassword}
        hint="At least 8 characters"
        testId="reset-password"
      />
      {error ? (
        <div className="q-banner" data-testid="reset-error">
          {error}
        </div>
      ) : null}
      <Button  type="submit" disabled={busy || password.length < 8} data-testid="reset-submit">
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="q-auth" data-testid="reset-password-page">
      <div className="q-auth__card">
        <div>
          <div className="q-wordmark">Xperiment</div>
          <p className="q-auth__tagline" style={{ marginTop: 4 }}>
            Choose a new password.
          </p>
        </div>
        {/* useSearchParams needs a Suspense boundary under the app router. */}
        <Suspense fallback={null}>
          <ResetForm />
        </Suspense>
      </div>
    </main>
  );
}
