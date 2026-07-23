import { createHash } from 'node:crypto';
import type { WorkflowIR } from './types.js';

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(',')}}`;
}

export function canonicalHash(ir: WorkflowIR): string {
  return createHash('sha256').update(canonicalStringify(ir)).digest('hex');
}
