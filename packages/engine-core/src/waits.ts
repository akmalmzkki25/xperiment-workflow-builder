export type ApprovalFallback = 'approve' | 'reject' | 'fail';

export interface FallbackOutcome {
  terminal: 'SUCCEEDED' | 'FAILED';
  outputPort?: 'approved' | 'rejected';
}

/** How an approval resolves when it expires without a human decision. */
export function approvalFallbackOutcome(fallback: ApprovalFallback): FallbackOutcome {
  switch (fallback) {
    case 'approve':
      return { terminal: 'SUCCEEDED', outputPort: 'approved' };
    case 'reject':
      return { terminal: 'SUCCEEDED', outputPort: 'rejected' };
    case 'fail':
      return { terminal: 'FAILED' };
  }
}
