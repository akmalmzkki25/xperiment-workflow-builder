/**
 * Status → visual metadata. Statuses are always rendered as glyph + label +
 * color together (UIUX §4.10: never color alone).
 */

export interface StatusMeta {
  label: string;
  glyph: string;
  colorVar: string;
  pulse?: boolean;
}

const STATUS_META: Record<string, StatusMeta> = {
  SUCCEEDED: { label: 'Succeeded', glyph: '✓', colorVar: '--status-succeeded' },
  FAILED: { label: 'Failed', glyph: '✕', colorVar: '--status-failed' },
  TIMED_OUT: { label: 'Timed out', glyph: '⏱', colorVar: '--status-failed' },
  RUNNING: { label: 'Running', glyph: '●', colorVar: '--status-running', pulse: true },
  QUEUED: { label: 'Queued', glyph: '◌', colorVar: '--status-neutral' },
  CREATED: { label: 'Created', glyph: '◌', colorVar: '--status-neutral' },
  PENDING: { label: 'Pending', glyph: '◌', colorVar: '--status-neutral' },
  READY: { label: 'Ready', glyph: '◌', colorVar: '--status-neutral' },
  RETRY_SCHEDULED: { label: 'Retrying', glyph: '↻', colorVar: '--status-retry' },
  SKIPPED: { label: 'Skipped', glyph: '○', colorVar: '--status-neutral' },
  draft: { label: 'Draft', glyph: '◌', colorVar: '--status-neutral' },
  published: { label: 'Published', glyph: '◆', colorVar: '--status-running' },
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? { label: status, glyph: '•', colorVar: '--status-neutral' };
}
