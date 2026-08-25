import * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * A native `select` wearing the shadcn control styling.
 *
 * Deliberately not shadcn's Radix `Select`: that renders a portalled listbox, which loses
 * the OS picker on mobile and cannot be driven by Playwright's `selectOption`. Every
 * select in this app is a plain filter or enum choice, so the native element is the better
 * control — it just needs to look like the rest of the system, which is what this is for.
 */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentPropsWithoutRef<'select'>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm',
        'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
NativeSelect.displayName = 'NativeSelect';
