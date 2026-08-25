'use client';

import Link from 'next/link';
import { Wordmark } from '@/components/common/Wordmark';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, getBrowserClient } from '../../lib/api';
import { clearToken, setToken } from '../../lib/auth';
import { TextField } from '../common/TextField';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set only once a password has bought a challenge; nothing is stored until the code lands.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = getBrowserClient();
      // Drop any prior session's stored workspace so this account doesn't send a
      // stale X-Xperiment-Workspace it isn't a member of (→ 403 on every request).
      clearToken();
      const result =
        mode === 'register' ? await client.register(email, password) : await client.login(email, password);
      // Discriminate on `challenge`: it exists on exactly one arm, so this narrows cleanly
      // where a truthiness check on the optional `mfaRequired` does not.
      if ('challenge' in result) {
        // The password bought a challenge, not a session. Nothing is stored yet.
        setChallenge(result.challenge);
        setBusy(false);
        return;
      }
      setToken(result.token);
      router.replace('/workflows');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong — is the API running?');
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--color-lontar)] p-8">
      <Card className="flex w-[min(400px,100%)] flex-col gap-6 rounded-[14px] p-10">
        <div>
          <Wordmark />
          <p className="mt-1 text-secondary-foreground">
            Workflow automation for teams that ship.
          </p>
        </div>
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {challenge ? (
            <TextField
              label="Code from your authenticator app"
              value={code}
              onChange={setCode}
              testId="mfa-login-code"
            />
          ) : (
            <>
              <TextField label="Email" type="email" value={email} onChange={setEmail} testId="auth-email" />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                hint={mode === 'register' ? 'At least 8 characters' : undefined}
                testId="auth-password"
              />
            </>
          )}
          {error ? (
            <Alert className="flex flex-wrap items-center gap-3" data-testid="auth-error">
              {error}
            </Alert>
          ) : null}
          {challenge ? (
            <Button
              type="button"
              disabled={busy || code.length < 6}
              data-testid="mfa-login-submit"
              onClick={() => {
                setBusy(true);
                setError(null);
                void getBrowserClient()
                  .mfaVerify(challenge, code)
                  .then(({ token }) => {
                    setToken(token);
                    router.replace('/workflows');
                  })
                  .catch((e: unknown) => {
                    setError(e instanceof ApiError ? e.message : 'Could not verify the code');
                    setBusy(false);
                  });
              }}
            >
              Continue
            </Button>
          ) : (
            <Button  type="submit" disabled={busy || !email || !password} data-testid="auth-submit">
              {mode === 'register' ? 'Create account' : 'Sign in'}
            </Button>
          )}
        </form>
        {mode === 'login' ? (
          <p style={{ color: 'var(--text-secondary)' }}>
            <Link href="/forgot-password" data-testid="forgot-link">
              Forgot your password?
            </Link>
          </p>
        ) : null}
        <p style={{ color: 'var(--text-secondary)' }}>
          {mode === 'register' ? (
            <>
              Already have an account? <Link href="/login">Sign in</Link>
            </>
          ) : (
            <>
              New to Xperiment? <Link href="/register">Create an account</Link>
            </>
          )}
        </p>
      </Card>
    </main>
  );
}
