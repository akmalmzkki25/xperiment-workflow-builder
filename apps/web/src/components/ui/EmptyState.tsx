import type { ReactNode } from 'react';

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="q-empty">
      <div className="q-empty__title">{title}</div>
      <p>{hint}</p>
      {action}
    </div>
  );
}
