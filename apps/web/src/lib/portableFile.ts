import type { WorkflowExportDoc } from './api';

/**
 * Reading a `.xperiment.json` somebody hands you.
 *
 * The server re-validates everything and is the authority; this exists so that picking
 * the wrong file in a folder produces a sentence about that file rather than a 422 about
 * a workflow the person never meant to create.
 */

/** Refused before `JSON.parse`, which is synchronous and would block the tab. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export const SUPPORTED_FORMAT = 1;

export type ParseResult =
  | { ok: true; doc: WorkflowExportDoc }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'not_json' }
  | { ok: false; reason: 'not_an_export' }
  | { ok: false; reason: 'unsupported_format'; found: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseExportFile(text: string): ParseResult {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, reason: 'too_large' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_export' };
  const format = raw['xperimentExport'];
  if (typeof format !== 'number' || typeof raw['name'] !== 'string' || !isRecord(raw['definition'])) {
    return { ok: false, reason: 'not_an_export' };
  }
  // Checked after the shape, so an unrelated JSON file is "not an export" rather than
  // "unsupported format" — the two need different sentences.
  if (format !== SUPPORTED_FORMAT) return { ok: false, reason: 'unsupported_format', found: format };
  const manifest = raw['requiredConnections'];
  return {
    ok: true,
    doc: {
      xperimentExport: format,
      name: raw['name'],
      definition: raw['definition'],
      requiredConnections: Array.isArray(manifest) ? (manifest as WorkflowExportDoc['requiredConnections']) : [],
    },
  };
}

/** Cosmetic: the browser names the download, so this only has to be readable. */
export function exportFilename(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${slug || 'workflow'}.xperiment.json`;
}
