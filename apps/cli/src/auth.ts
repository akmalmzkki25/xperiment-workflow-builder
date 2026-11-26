import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function dir(): string {
  return process.env['XPERIMENT_HOME'] ?? join(homedir(), '.xperiment');
}
function file(): string {
  return join(dir(), 'credentials.json');
}

export function saveToken(token: string): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(), JSON.stringify({ token }), { mode: 0o600 });
}

export function clearToken(): void {
  try {
    writeFileSync(file(), JSON.stringify({}), { mode: 0o600 });
  } catch {
    /* nothing stored there */
  }
}

export function loadToken(): string | null {
  const env = process.env['XPERIMENT_TOKEN'];
  if (env) return env;
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as { token?: string };
    if (parsed.token) return parsed.token;
  } catch {
    /* no stored token */
  }
  return null;
}
