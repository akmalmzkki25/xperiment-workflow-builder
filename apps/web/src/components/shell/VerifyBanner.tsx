'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { getBrowserClient } from '../../lib/api';

/**
 * Nudges an unconfirmed address without blocking anything. Verification gates no feature
 * yet, so a workspace whose address is confirmed — or whose `me` call has not landed —
 * sees nothing at all.
 */
export function VerifyBanner() {
  const [resent, setResent] = useState(false);
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => getBrowserClient().me(), retry: false });

  if (!meQ.data || meQ.data.emailVerified) return null;

  return (
    <div className="q-banner q-banner--warn" data-testid="verify-banner">
      <span>Confirm your email address to secure your account.</span>
      {resent ? (
        <span data-testid="verify-resent">Sent — check your inbox.</span>
      ) : (
        <Button variant="ghost" size="sm"
          type="button"
          
          data-testid="verify-resend"
          onClick={() => {
            // Already-verified and rate-limited both land in catch; either way the honest
            // answer to the reader is the same, and a second click changes nothing.
            void getBrowserClient()
              .resendVerification()
              .catch(() => undefined)
              .finally(() => setResent(true));
          }}
        >
          Resend
        </Button>
      )}
    </div>
  );
}
