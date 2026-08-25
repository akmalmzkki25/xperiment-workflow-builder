'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useEffect, useState, type ReactNode } from 'react';
import { IncidentBanner } from '../../components/shell/IncidentBanner';
import { QuotaBanner } from '../../components/shell/QuotaBanner';
import { Sidebar } from '../../components/shell/Sidebar';
import { VerifyBanner } from '../../components/shell/VerifyBanner';
import { WorkspaceSwitcher } from '../../components/shell/WorkspaceSwitcher';
import { getBrowserClient } from '../../lib/api';
import { clearToken, getToken } from '../../lib/auth';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <div className="grid min-h-screen grid-cols-[220px_1fr]">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center justify-end gap-3 border-b bg-card px-8">
          <WorkspaceSwitcher />
          <Button variant="ghost" size="sm"
            
            data-testid="logout"
            onClick={() => {
              void getBrowserClient()
                .logout()
                .catch(() => undefined)
                .finally(() => {
                  clearToken();
                  router.replace('/login');
                });
            }}
          >
            Sign out
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-6 p-8">
          <VerifyBanner />
          <IncidentBanner />
          <QuotaBanner />
          {children}
        </div>
      </div>
    </div>
  );
}
