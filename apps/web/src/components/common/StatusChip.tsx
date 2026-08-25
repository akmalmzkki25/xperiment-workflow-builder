import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { statusMeta } from '../../lib/statusMeta';

/**
 * Status is never colour alone — always a glyph and a label too (UIUX §10.1), which is
 * why the badge carries all three rather than relying on the tint.
 */
export function StatusChip({ status, testId }: { status: string; testId?: string }) {
  const meta = statusMeta(status);
  return (
    <Badge
      variant="outline"
      className="gap-1 border-current bg-current/[0.09] font-medium"
      style={{ color: `var(${meta.colorVar})` }}
      data-testid={testId}
    >
      <span aria-hidden className={cn(meta.pulse && 'animate-xperiment-pulse')}>
        {meta.glyph}
      </span>
      {meta.label}
    </Badge>
  );
}

/** Arus lime, reserved for live/active signals and nothing else (UIUX §10.1). */
export function LiveChip({ label, testId }: { label: string; testId?: string }) {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-live bg-live/20 font-medium text-foreground"
      data-testid={testId}
    >
      <span aria-hidden className="text-live">
        ◉
      </span>
      {label}
    </Badge>
  );
}
