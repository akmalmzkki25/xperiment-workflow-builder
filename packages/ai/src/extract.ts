/**
 * Pull a JSON object out of a model completion that may wrap it in ```json
 * fences, prepend an illustrative example, or surround it with prose.
 *
 * Strategy: scan the WHOLE text (string-aware, so braces and backticks inside
 * string values don't confuse it) for every balanced top-level object, parse
 * each, and prefer the one that looks like a workflow. This tolerates decoy
 * example blocks, code fences, and stray prose braces. Throws SyntaxError if
 * nothing parses.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    // Fast path: the whole response is one JSON value (the instructed shape).
    const whole = JSON.parse(trimmed);
    if (whole !== null && typeof whole === 'object') return whole;
  } catch {
    // fall through to scanning
  }

  const objects = findBalancedObjects(text);
  if (objects.length === 0) throw new SyntaxError('no JSON object found in completion');

  // Prefer a workflow-shaped object; among matches, the last one (models often
  // emit an example first and the real answer last). Otherwise the last parsed.
  const workflowLike = objects.filter(looksLikeWorkflow);
  const chosen = workflowLike.length > 0 ? workflowLike[workflowLike.length - 1] : objects[objects.length - 1];
  return chosen;
}

function looksLikeWorkflow(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return 'schemaVersion' in v || Array.isArray(v['nodes']);
}

/** Every balanced, JSON-parseable top-level object in the text, in order. */
function findBalancedObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i += 1;
      continue;
    }
    const end = scanBalanced(text, i);
    if (end === -1) break; // no closing brace anywhere after here
    try {
      found.push(JSON.parse(text.slice(i, end + 1)));
      i = end + 1;
    } catch {
      // not valid JSON starting here (e.g. a prose brace) — advance past it
      i += 1;
    }
  }
  return found;
}

/** Index of the `}` that closes the `{` at `start`, or -1. String-aware. */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
