import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEnv, parseEnvFile } from './env.js';
import { dependenciesOf, preflightMessage, unreachable } from './preflight.js';
import { portConflicts, resolvePorts } from './services.js';
import { startService, stillHeld, stopService, type RunningService } from './supervisor.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function loadEnv(): Promise<Record<string, string>> {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(await readFile(resolve(ROOT, '.env'), 'utf8'));
  } catch {
    // No .env is the normal case: every default in the repo points at the local stack.
  }
  return mergeEnv(fileEnv, process.env);
}

const env = await loadEnv();

const conflicts = portConflicts(env);
if (conflicts.length > 0) {
  console.error(`Refusing to start:\n${conflicts.map((c) => `  - ${c}`).join('\n')}`);
  process.exit(1);
}

const missing = await unreachable(dependenciesOf(env));
const problem = preflightMessage(missing);
if (problem !== null) {
  console.error(problem);
  process.exit(1);
}

const running: RunningService[] = [];
for (const { service, port } of resolvePorts(env)) {
  console.log(`starting ${service.name.padEnd(13)} :${port}`);
  running.push(startService(service, port, env));
}
console.log(`\nAll six are starting. Open http://localhost:${resolvePorts(env)[5]?.port ?? 3005} — Ctrl-C stops everything.\n`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — stopping ${running.length} service(s).`);
  await Promise.all(running.map(stopService));
  // Reported, never swept: killing by port here would eventually take out an unrelated
  // dev server on 3000, and a tool that does that once is a tool nobody runs again.
  const held = await stillHeld(running.map((r) => r.port));
  if (held.length > 0) {
    console.error(`Still listening: ${held.join(', ')}. A shell wrapper outlived its tree — close those manually.`);
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
