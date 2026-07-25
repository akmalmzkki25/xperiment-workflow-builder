'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/workflows', label: 'Workflows' },
  { href: '/templates', label: 'Templates' },
  { href: '/executions', label: 'Executions' },
  { href: '/usage', label: 'Usage' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/connections', label: 'Connections' },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="q-sidebar">
      <Link href="/workflows" className="q-sidebar__brand" style={{ color: 'inherit', textDecoration: 'none' }}>
        Xperiment
      </Link>
      <nav className="q-sidebar__nav" aria-label="Main navigation">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={active ? 'q-sidebar__link q-sidebar__link--active' : 'q-sidebar__link'}
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
