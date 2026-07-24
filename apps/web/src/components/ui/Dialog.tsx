'use client';

import type { ReactNode } from 'react';

interface DialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

export function Dialog({ title, open, onClose, children, actions }: DialogProps) {
  if (!open) return null;
  return (
    <div
      className="q-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="q-dialog" role="dialog" aria-label={title}>
        <div className="q-dialog__title">{title}</div>
        {children}
        {actions ? <div className="q-dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
