export type ApprovalFallback = 'approve' | 'reject' | 'fail';

export interface FallbackOutcome {
  terminal: 'SUCCEEDED' | 'FAILED';
  outputPort?: 'approved' | 'rejected';
}

/**
 * How an approval resolves when it expires without a human decision. Any value
 * other than approve/reject (including a corrupt/unknown one) fails safe: the
 * node fails rather than silently proceeding on an unexpected path.
 */
export function approvalFallbackOutcome(fallback: ApprovalFallback): FallbackOutcome {
  if (fallback === 'approve') return { terminal: 'SUCCEEDED', outputPort: 'approved' };
  if (fallback === 'reject') return { terminal: 'SUCCEEDED', outputPort: 'rejected' };
  return { terminal: 'FAILED' };
}
