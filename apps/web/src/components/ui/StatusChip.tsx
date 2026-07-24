import { statusMeta } from '../../lib/statusMeta';

export function StatusChip({ status, testId }: { status: string; testId?: string }) {
  const meta = statusMeta(status);
  return (
    <span className="q-chip" style={{ color: `var(${meta.colorVar})` }} data-testid={testId}>
      <span aria-hidden className={meta.pulse ? 'q-chip__glyph--pulse' : undefined}>
        {meta.glyph}
      </span>
      {meta.label}
    </span>
  );
}

/** Arus-lime chip reserved for live/active signals (UIUX §10.1). */
export function LiveChip({ label, testId }: { label: string; testId?: string }) {
  return (
    <span className="q-chip q-chip--live" data-testid={testId}>
      <span aria-hidden>◉</span>
      {label}
    </span>
  );
}
