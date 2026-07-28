'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { IncidentBanner } from '../../components/shell/IncidentBanner';
import { QuotaBanner } from '../../components/shell/QuotaBanner';
import { Sidebar } from '../../components/shell/Sidebar';
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
    <div className="q-shell">
      <Sidebar />
      <div className="q-main">
        <header className="q-topbar">
          <WorkspaceSwitcher />
          <button
            className="q-btn q-btn--ghost q-btn--sm"
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
          </button>
        </header>
        <div className="q-content">
          <IncidentBanner />
          <QuotaBanner />
          {children}
        </div>
      </div>
    </div>
  );
}
