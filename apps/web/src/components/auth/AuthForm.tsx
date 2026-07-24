'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, getBrowserClient } from '../../lib/api';
import { setToken } from '../../lib/auth';
import { TextField } from '../ui/TextField';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = getBrowserClient();
      const { token } =
        mode === 'register' ? await client.register(email, password) : await client.login(email, password);
      setToken(token);
      router.replace('/workflows');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong — is the API running?');
      setBusy(false);
    }
  };

  return (
    <main className="q-auth">
      <div className="q-auth__card">
        <div>
          <div className="q-wordmark">Xperiment</div>
          <p className="q-auth__tagline" style={{ marginTop: 4 }}>
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
          <TextField label="Email" type="email" value={email} onChange={setEmail} testId="auth-email" />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            hint={mode === 'register' ? 'At least 8 characters' : undefined}
            testId="auth-password"
          />
          {error ? (
            <div className="q-banner" data-testid="auth-error">
              {error}
            </div>
          ) : null}
          <button className="q-btn" type="submit" disabled={busy || !email || !password} data-testid="auth-submit">
            {mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>
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
      </div>
    </main>
  );
}
