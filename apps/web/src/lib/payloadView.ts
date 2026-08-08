/** Rendering-ready view of a recorded node payload. */
export interface PayloadPreview {
  text: string;
  /** Approximate size of the full value, before any truncation. */
  bytes: number;
  truncated: boolean;
  /** The node recorded nothing here — different from "recorded an empty object". */
  empty: boolean;
}

const DEFAULT_MAX_CHARS = 20_000;

/**
 * A node payload can be up to 256 KiB, and several attempts render at once, so the
 * browser gets a bounded slice rather than the whole thing.
 */
export function previewPayload(value: unknown, maxChars: number = DEFAULT_MAX_CHARS): PayloadPreview {
  if (value === null || value === undefined) {
    return { text: '', bytes: 0, truncated: false, empty: true };
  }
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? '';
  } catch {
    // A cycle cannot come out of JSONB, but a caller could hand us anything.
    return { text: '[unrenderable value]', bytes: 0, truncated: false, empty: false };
  }
  if (full === '') return { text: '', bytes: 0, truncated: false, empty: true };
  const truncated = full.length > maxChars;
  return {
    text: truncated ? `${full.slice(0, maxChars)}\n… truncated` : full,
    bytes: full.length,
    truncated,
    empty: false,
  };
}

/** "1.2 KB" reads better than "1231 characters" next to a disclosure toggle. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
