'use client';

import Link from 'next/link';
import { Wordmark } from '@/components/common/Wordmark';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { TextField } from '../../components/common/TextField';
import { getBrowserClient } from '../../lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    // The endpoint answers identically for unknown addresses, and so must this page —
    // showing "no such account" here would undo the server's enumeration resistance.
    // A network failure lands in the same place for the same reason.
    await getBrowserClient()
      .forgotPassword(email)
      .catch(() => undefined);
    setBusy(false);
    setDone(true);
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--color-lontar)] p-8" data-testid="forgot-password-page">
      <Card className="flex w-[min(400px,100%)] flex-col gap-6 rounded-[14px] p-10">
        <div>
          <Wordmark />
          <p className="mt-1 text-secondary-foreground">
            Reset your password.
          </p>
        </div>
        {done ? (
          <p data-testid="forgot-sent">
            If an account exists for {email}, a reset link is on its way. The link is valid for one hour.
          </p>
        ) : (
          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <TextField label="Email" type="email" value={email} onChange={setEmail} testId="forgot-email" />
            <Button  type="submit" disabled={busy || !email} data-testid="forgot-submit">
              Send reset link
            </Button>
          </form>
        )}
        <p style={{ color: 'var(--text-secondary)' }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </Card>
    </main>
  );
}
