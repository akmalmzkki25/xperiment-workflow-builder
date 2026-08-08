export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function fmtDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

/**
 * Absolute wall time in Jakarta, with the zone named.
 *
 * Schedules default to Asia/Jakarta on the server, so a wait's expiry has to be shown in
 * the same frame. A relative "expires in 2 hours" computed off an arbitrary browser clock
 * is exactly how an operator in another timezone misreads it.
 */
export function fmtJakarta(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('day')}/${pick('month')}/${pick('year')} ${pick('hour')}:${pick('minute')} WIB`;
}

/**
 * How an execution row's node id reads to a person. The engine encodes loop iterations into
 * the id (`b1#3`) and adds a synthetic join (`lp$join`); neither is something an author wrote,
 * so neither should be shown raw.
 *
 * The iteration is reported 1-based: the id counts from zero, people do not.
 */
export function nodeLabel(nodeId: string): { text: string; iteration: number | null } {
  if (nodeId.endsWith('$join')) {
    return { text: `${nodeId.slice(0, -'$join'.length)} — all iterations done`, iteration: null };
  }
  const at = nodeId.lastIndexOf('#');
  if (at > 0) {
    const suffix = nodeId.slice(at + 1);
    if (/^\d+$/.test(suffix)) return { text: nodeId.slice(0, at), iteration: Number(suffix) + 1 };
  }
  return { text: nodeId, iteration: null };
}
