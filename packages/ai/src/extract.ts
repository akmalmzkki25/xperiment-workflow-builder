/**
 * Pull a JSON object out of a model completion that may wrap it in ```json
 * fences or surrounding prose. Returns the first balanced top-level object;
 * throws SyntaxError if none parses.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;

  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace scanning
  }

  const start = candidate.indexOf('{');
  if (start === -1) throw new SyntaxError('no JSON object found in completion');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!;
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
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new SyntaxError('no balanced JSON object found in completion');
}
