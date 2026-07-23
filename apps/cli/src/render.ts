const SYMBOLS: Record<string, string> = {
  SUCCEEDED: '[ok]',
  FAILED: '[x]',
  SKIPPED: '[skip]',
  RETRY_SCHEDULED: '[retry]',
  RUNNING: '[run]',
  QUEUED: '[..]',
  READY: '[..]',
  PENDING: '[..]',
};

export function renderTimeline(detail: {
  execution: { status: string };
  nodes: { nodeId: string; status: string; attempt: number; startedAt: string | null; completedAt: string | null }[];
}): string {
  const lines = [`Execution: ${detail.execution.status}`];
  for (const n of detail.nodes) {
    const symbol = SYMBOLS[n.status] ?? '[?]';
    let duration = '';
    if (n.startedAt && n.completedAt) {
      duration = ` ${new Date(n.completedAt).getTime() - new Date(n.startedAt).getTime()}ms`;
    }
    lines.push(`  ${symbol} ${n.nodeId} (attempt ${n.attempt}) ${n.status}${duration}`);
  }
  return lines.join('\n');
}
