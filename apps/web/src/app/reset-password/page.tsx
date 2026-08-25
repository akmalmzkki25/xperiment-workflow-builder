'use client';

import Link from 'next/link';
import { Wordmark } from '@/components/common/Wordmark';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
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
        <Alert className="flex flex-wrap items-center gap-3" data-testid="reset-error">
          {error}
        </Alert>
      ) : null}
      <Button  type="submit" disabled={busy || password.length < 8} data-testid="reset-submit">
        Set new password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--color-lontar)] p-8" data-testid="reset-password-page">
      <Card className="flex w-[min(400px,100%)] flex-col gap-6 rounded-[14px] p-10">
        <div>
          <Wordmark />
          <p className="mt-1 text-secondary-foreground">
            Choose a new password.
          </p>
        </div>
        {/* useSearchParams needs a Suspense boundary under the app router. */}
        <Suspense fallback={null}>
          <ResetForm />
        </Suspense>
      </Card>
    </main>
  );
}
