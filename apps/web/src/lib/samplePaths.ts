/**
 * Turns a recorded trigger payload into copy-ready expression paths.
 *
 * This is the actual authoring win of the sample viewer. Seeing the JSON tells you the
 * data arrived; being handed `{{ trigger.body.items[0].sku }}` is what stops you
 * guessing whether the field is `sku`, `SKU` or nested one level deeper than you think.
 */

export interface SamplePath {
  /** The expression body, without the braces. */
  path: string;
  /** What sits at that path, short enough for a list. */
  preview: string;
}

export interface PathOptions {
  root?: string;
  maxPaths?: number;
  maxDepth?: number;
}

const DEFAULTS = { root: 'trigger', maxPaths: 200, maxDepth: 6 };
const PREVIEW_CHARS = 48;
/** Matches what the expression parser accepts as a bare member, so the rest is bracketed. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function step(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function preview(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).length;
    return `object with ${keys} key${keys === 1 ? '' : 's'}`;
  }
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/**
 * Every path worth offering, containers included.
 *
 * Containers are emitted as well as leaves because `{{ trigger.body.items }}` is what
 * feeds a loop — offering only the leaves would hide the single most useful path.
 * Arrays contribute their first element only: a hundred rows of identical shape make
 * a hundred identical suggestions, and the author wants the shape, not the data.
 */
export function expressionPaths(sample: unknown, options: PathOptions = {}): SamplePath[] {
  const { root, maxPaths, maxDepth } = { ...DEFAULTS, ...options };
  const out: SamplePath[] = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    if (out.length >= maxPaths) return;
    if (path !== root) out.push({ path, preview: preview(value) });
    if (depth >= maxDepth || value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      if (value.length > 0) walk(value[0], `${path}[0]`, depth + 1);
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (out.length >= maxPaths) return;
      walk((value as Record<string, unknown>)[key], step(path, key), depth + 1);
    }
  };

  walk(sample, root, 0);
  return out;
}
