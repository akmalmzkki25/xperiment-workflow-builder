import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.xperiment');
const FILE = join(DIR, 'credentials.json');

export function saveToken(token: string): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ token }), { mode: 0o600 });
}

export function clearToken(): void {
  try {
    writeFileSync(FILE, JSON.stringify({}), { mode: 0o600 });
  } catch {
    /* nothing stored */
  }
}

export function loadToken(): string | null {
  const env = process.env['XPERIMENT_TOKEN'];
  if (env) return env;
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as { token?: string };
    return parsed.token ?? null;
  } catch {
    return null;
  }
}
