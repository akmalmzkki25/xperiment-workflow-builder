'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from '@/components/common/Wordmark';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/workflows', label: 'Workflows' },
  { href: '/templates', label: 'Templates' },
  { href: '/executions', label: 'Executions' },
  { href: '/usage', label: 'Usage' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/connections', label: 'Connections' },
  { href: '/members', label: 'Members' },
  { href: '/security', label: 'Security' },
  { href: '/audit', label: 'Audit' },
  { href: '/plan', label: 'Plan' },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="flex flex-col gap-8 bg-[var(--surface-ink)] py-6 text-[var(--text-on-ink)]">
      <Link href="/workflows" className="px-6 text-inherit no-underline">
        <Wordmark size="compact" />
      </Link>
      <nav className="flex flex-col gap-0.5" aria-label="Main navigation">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              // The active marker is a left border rather than a filled pill: the rail
              // reads as "you are here" without competing with the lime, which this app
              // reserves for things that are actually running.
              className={cn(
                'block border-l-[3px] border-transparent px-6 py-2 font-medium no-underline',
                'text-[var(--text-on-ink-muted)] hover:text-[var(--text-on-ink)]',
                active && 'border-l-[var(--color-arus)] bg-white/5 text-[var(--text-on-ink)]',
              )}
              data-testid={`nav-${item.label.toLowerCase()}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
