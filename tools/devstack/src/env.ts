/**
 * Reads `.env` without a dependency.
 *
 * `dotenv` is not in the tree and nothing in this repo has ever loaded a `.env` file —
 * every service reads the ambient environment. Adding a runtime dependency so a dev
 * convenience script can read six lines is a poor trade, and the parser below is small
 * enough to hold in your head.
 *
 * Deliberately no `$VAR` interpolation. A file whose meaning depends on the shell that
 * happened to read it is a file that behaves differently for every person on the team.
 */

/** Strip a matching pair of surrounding quotes, if present. */
function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.length > 1 && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  // An unquoted value ends at the first ` #`, which is how people write trailing notes.
  const comment = value.indexOf(' #');
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on \n and drop a trailing \r: the file is edited on Windows as often as not.
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // Only the FIRST `=` splits: secrets are base64 and URLs carry query strings.
    out[key] = unquote(withoutExport.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Merge a parsed file under the real environment.
 *
 * The ambient environment always wins. A CI job that exported `DATABASE_URL` must not be
 * silently overridden by a `.env` somebody left in their checkout — that is the failure
 * where a pipeline writes to the wrong database and nobody can explain how.
 *
 * A variable explicitly set to the empty string counts as set: somebody typed it.
 */
export function mergeEnv(
  fileEnv: Readonly<Record<string, string>>,
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
