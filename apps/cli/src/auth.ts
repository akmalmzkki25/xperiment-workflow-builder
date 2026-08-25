import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Both names are read, new first. The rename should not sign anyone out of a CLI they
// logged into yesterday, and the old variable is likely still in someone's shell profile.
function dir(): string {
  return process.env['XPERIMENT_HOME'] ?? process.env['XPERIMENT_HOME'] ?? join(homedir(), '.xperiment');
}
function file(): string {
  return join(dir(), 'credentials.json');
}

/** Where a pre-rename CLI kept its token, still read when the new path has none. */
function legacyFile(): string {
  return join(process.env['XPERIMENT_HOME'] ?? join(homedir(), '.xperiment'), 'credentials.json');
}

export function saveToken(token: string): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify({ token }), { mode: 0o600 });
}

export function clearToken(): void {
  // Both locations: clearing only the new one would leave `loadToken` falling back to a
  // pre-rename file, and a logout that does not log out is worse than no logout at all.
  for (const path of [file(), legacyFile()]) {
    try {
      writeFileSync(path, JSON.stringify({}), { mode: 0o600 });
    } catch {
      /* nothing stored there */
    }
  }
}

export function loadToken(): string | null {
  const env = process.env['XPERIMENT_TOKEN'] ?? process.env['XPERIMENT_TOKEN'];
  if (env) return env;
  for (const path of [file(), legacyFile()]) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { token?: string };
      if (parsed.token) return parsed.token;
    } catch {
      /* try the next location */
    }
  }
  return null;
}
