import { cn } from '@/lib/cn';

/** The product name. Lives in one place so the brand is never half-renamed. */
export const BRAND_NAME = 'Xperiment';

const SIZES = {
  display: 'text-[length:var(--text-display)] tracking-[-0.02em] after:ml-1.5 after:size-2.5',
  compact: 'text-[length:var(--text-h2)] tracking-[-0.01em] after:ml-[5px] after:size-2',
} as const;

/**
 * The wordmark, with the Arus dot after it.
 *
 * The dot is a `::after` rather than a character so it never gets selected, copied, or
 * read aloud — it is decoration, and the accessible name should be the name alone.
 */
export function Wordmark({
  size = 'display',
  className,
}: {
  size?: keyof typeof SIZES;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "font-bold after:inline-block after:rounded-full after:bg-[var(--color-arus)] after:align-middle after:content-['']",
        SIZES[size],
        className,
      )}
    >
      {BRAND_NAME}
    </span>
  );
}
