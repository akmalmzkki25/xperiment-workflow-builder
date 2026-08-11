import { Command } from 'commander';
import { describe, expect, test } from 'vitest';
import { normalizeArgv } from '../src/argv.js';

const NODE = ['/usr/bin/node', '/app/main.ts'];

describe('normalizeArgv', () => {
  test('drops the terminator the root pnpm script forwards', () => {
    expect(normalizeArgv([...NODE, '--', 'prune', '--dry-run'])).toEqual([...NODE, 'prune', '--dry-run']);
  });

  test('leaves a normal invocation untouched', () => {
    expect(normalizeArgv([...NODE, 'prune', '--dry-run'])).toEqual([...NODE, 'prune', '--dry-run']);
  });

  test('keeps a deliberate terminator that comes later', () => {
    expect(normalizeArgv([...NODE, 'run', 'wf1', '--', '--not-a-flag'])).toEqual([
      ...NODE,
      'run',
      'wf1',
      '--',
      '--not-a-flag',
    ]);
  });

  test('never mutates the argv it was given', () => {
    const argv = [...NODE, '--', 'seed'];
    normalizeArgv(argv);
    expect(argv).toEqual([...NODE, '--', 'seed']);
  });

  test('a bare invocation survives', () => {
    expect(normalizeArgv(NODE)).toEqual(NODE);
  });
});

describe('commander with a forwarded terminator', () => {
  // The regression this exists for: `xperiment prune --dry-run` parsed as a run with no flags
  // and deleted for real. The flag was not rejected — it was silently demoted to an
  // operand, which is the failure mode nobody notices until data is gone.
  function parse(argv: string[]): { dryRun?: boolean } {
    let seen: { dryRun?: boolean } = {};
    const program = new Command().name('xperiment').exitOverride();
    program
      .command('prune')
      .option('--dry-run')
      .action((opts: { dryRun?: boolean }) => {
        seen = opts;
      });
    program.parse(argv);
    return seen;
  }

  test('a raw terminator swallows the flag', () => {
    expect(parse([...NODE, '--', 'prune', '--dry-run']).dryRun).toBeUndefined();
  });

  test('normalizing first delivers the flag', () => {
    expect(parse(normalizeArgv([...NODE, '--', 'prune', '--dry-run'])).dryRun).toBe(true);
  });
});
