import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { clearToken, loadToken, saveToken } from '../src/auth.js';

const VARS = ['XPERIMENT_HOME', 'XPERIMENT_TOKEN'] as const;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xperiment-cli-'));
  for (const v of VARS) delete process.env[v];
  process.env['XPERIMENT_HOME'] = home;
});
afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

describe('cli token store', () => {
  test('save/load/clear round-trip', () => {
    expect(loadToken()).toBeNull();
    saveToken('qs_test-token');
    expect(loadToken()).toBe('qs_test-token');
    clearToken();
    expect(loadToken()).toBeNull();
  });

  test('XPERIMENT_TOKEN env wins over the stored file', () => {
    saveToken('qs_stored');
    process.env['XPERIMENT_TOKEN'] = 'qs_env';
    expect(loadToken()).toBe('qs_env');
  });

  test('corrupt store file yields null', () => {
    saveToken('x');
    writeFileSync(join(home, 'credentials.json'), '{not json');
    expect(loadToken()).toBeNull();
  });
});
