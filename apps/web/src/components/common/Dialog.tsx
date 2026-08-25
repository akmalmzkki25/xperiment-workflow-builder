'use client';

import type { ReactNode } from 'react';
import {
  Dialog as Root,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface DialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

/**
 * The app's dialog, now Radix underneath.
 *
 * The prop shape is unchanged on purpose: every caller and every `data-testid` keeps
 * working, and what they gain for free is the focus trap, the Escape handler and the
 * aria wiring that the hand-rolled version never had.
 */
export function Dialog({ title, open, onClose, children, actions }: DialogProps) {
  return (
    <Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg gap-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">{children}</div>
        {actions ? <DialogFooter className="gap-2">{actions}</DialogFooter> : null}
      </DialogContent>
    </Root>
  );
}
