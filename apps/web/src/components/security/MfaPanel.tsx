'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useState, type CSSProperties } from 'react';
import { TextField } from '../common/TextField';
import { ApiError, getBrowserClient } from '../../lib/api';
import { QrCode } from './QrCode';

type Stage = { kind: 'idle' } | { kind: 'enrolling'; uri: string; key: string } | { kind: 'codes'; codes: string[] };

/** The surface the plan page uses; there is no shared card class in this codebase. */
export const PANEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-4)',
  padding: 'var(--space-5)',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-node)',
};

/** Groups the base32 key into fours so it can be typed by hand without losing the place. */
function grouped(key: string): string {
  return key.replace(/(.{4})/g, '$1 ').trim();
}

export function MfaPanel({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [code, setCode] = useState('');
  // Enrolment re-authenticates. A stolen session must not be able to attach a factor the
  // real owner does not hold — a password reset would not remove it.
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const r = await getBrowserClient().mfaSetup(password);
      setStage({ kind: 'enrolling', uri: r.otpauthUri, key: r.secretBase32 });
    });

  const confirm = () =>
    run(async () => {
      const r = await getBrowserClient().mfaConfirm(code, password);
      setCode('');
      setPassword('');
      setStage({ kind: 'codes', codes: r.recoveryCodes });
      await qc.invalidateQueries({ queryKey: ['me'] });
    });

  const disable = () =>
    run(async () => {
      await getBrowserClient().mfaDisable(code);
      setCode('');
      setStage({ kind: 'idle' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    });

  const regenerate = () =>
    run(async () => {
      const r = await getBrowserClient().mfaRecoveryCodes(code);
      setCode('');
      setStage({ kind: 'codes', codes: r.recoveryCodes });
    });

  return (
    <section style={PANEL} data-testid="mfa-panel">
      <h2 style={{ margin: 0 }}>Two-factor authentication</h2>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
        {enabled
          ? 'Your account asks for a code from your authenticator app at every sign in.'
          : 'Add a code from an authenticator app to your sign in.'}
      </p>

      {stage.kind === 'enrolling' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <QrCode value={stage.uri} />
          <p style={{ margin: 0 }}>
            Or type this key: <code data-testid="mfa-key">{grouped(stage.key)}</code>
          </p>
          <TextField label="Code from the app" value={code} onChange={setCode} testId="mfa-code" />
          <Button
            disabled={busy || code.length < 6}
            onClick={() => void confirm()}
            data-testid="mfa-confirm"
          >
            Turn on
          </Button>
        </div>
      ) : null}

      {stage.kind === 'codes' ? (
        <div data-testid="mfa-recovery">
          <p>
            <strong>Save these recovery codes now.</strong> Each works once, and they are the only way back into your
            account if you lose the app. They are not shown again.
          </p>
          <ul className="mono">
            {stage.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <Button variant="ghost"
            
            onClick={() => setStage({ kind: 'idle' })}
            data-testid="mfa-codes-done"
          >
            I have saved them
          </Button>
        </div>
      ) : null}

      {stage.kind === 'idle' && !enabled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <TextField
            label="Your password"
            type="password"
            value={password}
            onChange={setPassword}
            hint="Confirms it is really you before a second factor is attached"
            testId="mfa-password"
          />
          <Button
            disabled={busy || password.length === 0}
            onClick={() => void start()}
            data-testid="mfa-start"
          >
            Set up
          </Button>
        </div>
      ) : null}

      {stage.kind === 'idle' && enabled ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <TextField label="Current code or a recovery code" value={code} onChange={setCode} testId="mfa-proof" />
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Button variant="ghost"
              
              disabled={busy || code.length < 6}
              onClick={() => void regenerate()}
              data-testid="mfa-regenerate"
            >
              New recovery codes
            </Button>
            <Button variant="ghost"
              
              disabled={busy || code.length < 6}
              onClick={() => void disable()}
              data-testid="mfa-disable"
            >
              Turn off
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <Alert className="flex flex-wrap items-center gap-3" data-testid="mfa-error">
          {error}
        </Alert>
      ) : null}
    </section>
  );
}
