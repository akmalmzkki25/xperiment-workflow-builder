import type { Finding } from './api';

/** The key used for findings that describe the workflow rather than one node. */
export const WORKFLOW_LEVEL = '';

/**
 * Findings grouped by the node they blame.
 *
 * Lifted out of the editor component so the grouping is testable — it decides which
 * node draws a warning badge, and getting it wrong is silent.
 */
export function groupFindingsByNode(findings: readonly Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.nodeId ?? WORKFLOW_LEVEL;
    map.set(key, [...(map.get(key) ?? []), finding]);
  }
  return map;
}

/**
 * Whether clicking a finding can take you anywhere.
 *
 * A workflow-level finding — a missing entrypoint, a cycle — has no node to fly to,
 * and rendering it as a button that does nothing is worse than rendering it as text.
 */
export function isFocusable(finding: Finding): finding is Finding & { nodeId: string } {
  return typeof finding.nodeId === 'string' && finding.nodeId.length > 0;
}
