#!/usr/bin/env node
/**
 * Run every workspace package's test script, and do not stop at the first failure.
 *
 * `pnpm -r test` bails on the first failing package, so packages later in the order never
 * run at all — and the output still looks like a completed suite. That is how a real bug
 * in apps/web hid behind an unrelated failure in packages/db for a whole session.
 *
 * `pnpm -r --no-bail` runs everything but then exits 0 whether or not anything failed,
 * which trades one wrong answer for a worse one. Hence this: run all of them, print what
 * happened, exit non-zero if any failed.
 *
 * Sequential on purpose. The suites share one Postgres and one Redis, and running two
 * packages at once puts them back in each other's way — the problem this whole isolation
 * effort exists to remove.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const script = process.argv.includes('--coverage') ? 'test:cov' : 'test';
const only = process.argv.filter((a) => !a.startsWith('-')).slice(2);

/** Mirrors pnpm-workspace.yaml. Kept here rather than parsed: four lines, no yaml dependency. */
const GLOBS = ['packages', 'apps', 'tools'];

function packages() {
  const found = [];
  for (const base of GLOBS) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const dir = join(base, name);
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) found.push({ dir, manifest });
    }
  }
  if (existsSync('e2e/package.json')) found.push({ dir: 'e2e', manifest: 'e2e/package.json' });

  return found
    .map(({ dir, manifest }) => ({ dir, meta: JSON.parse(readFileSync(manifest, 'utf8')) }))
    .filter(({ meta }) => meta.scripts?.[script])
    .filter(({ meta }) => only.length === 0 || only.includes(meta.name))
    .map(({ dir, meta }) => ({ dir, name: meta.name }));
}

const results = [];
for (const pkg of packages()) {
  process.stdout.write(`\n\u2500\u2500 ${pkg.name} (${pkg.dir})\n`);
  const run = spawnSync('pnpm', ['--filter', pkg.name, 'run', script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  results.push({ name: pkg.name, code: run.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);
process.stdout.write(`\n${'='.repeat(60)}\n`);
for (const r of results) {
  process.stdout.write(`${r.code === 0 ? 'pass' : 'FAIL'}  ${r.name}\n`);
}
process.stdout.write(
  `${'='.repeat(60)}\n${results.length - failed.length}/${results.length} packages passed\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
