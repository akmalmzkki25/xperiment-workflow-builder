/**
 * The status choices on the executions list, and the statuses each one asks the server
 * for.
 *
 * The page used to filter the fetched page in the browser, so choosing FAILED showed
 * "No executions" whenever the last twenty runs had succeeded — while the failures sat
 * unreachable on page two. These values now go to the server.
 */

export interface StatusChoice {
  value: string;
  label: string;
  /** Undefined means no status predicate at all. */
  statuses?: readonly string[];
}

export const STATUS_CHOICES: readonly StatusChoice[] = [
  { value: 'ALL', label: 'All statuses' },
  // One look, because "did anything break?" is one question. Only possible now that the
  // predicate runs server-side.
  { value: 'PROBLEMS', label: 'Problems (failed or timed out)', statuses: ['FAILED', 'TIMED_OUT'] },
  { value: 'RUNNING', label: 'Running', statuses: ['RUNNING'] },
  { value: 'SUCCEEDED', label: 'Succeeded', statuses: ['SUCCEEDED'] },
  { value: 'FAILED', label: 'Failed', statuses: ['FAILED'] },
  { value: 'TIMED_OUT', label: 'Timed out', statuses: ['TIMED_OUT'] },
  { value: 'CANCELED', label: 'Canceled', statuses: ['CANCELED'] },
];

/** An unrecognised value falls back to ALL rather than sending the server a guess. */
export function statusesFor(value: string): readonly string[] | undefined {
  return STATUS_CHOICES.find((c) => c.value === value)?.statuses;
}

export function isKnownChoice(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && STATUS_CHOICES.some((c) => c.value === value);
}

/** Read the filter out of the URL, so a filtered view is a link somebody can send. */
export function choiceFromParams(raw: string | null | undefined): string {
  return isKnownChoice(raw) ? (raw as string) : 'ALL';
}

/** Build the querystring for the page's own URL. Never emits `status=ALL`. */
export function paramsForChoice(choice: string, workflowId?: string): string {
  const params = new URLSearchParams();
  if (workflowId) params.set('workflowId', workflowId);
  if (choice !== 'ALL' && isKnownChoice(choice)) params.set('status', choice);
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}
