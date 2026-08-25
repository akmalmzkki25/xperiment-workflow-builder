import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { clearToken, loadToken, saveToken } from '../src/auth.js';

const VARS = ['XPERIMENT_HOME', 'XPERIMENT_TOKEN', 'XPERIMENT_HOME', 'XPERIMENT_TOKEN'] as const;

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

describe('the rename does not strand an existing login', () => {
  test('a token stored under the old home is still found', () => {
    const old = mkdtempSync(join(tmpdir(), 'xperiment-cli-'));
    process.env['XPERIMENT_HOME'] = old;
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'credentials.json'), JSON.stringify({ token: 'qs_from_before' }));
    expect(loadToken()).toBe('qs_from_before');
  });

  test('logout clears the old location too, or it would sign back in', () => {
    const old = mkdtempSync(join(tmpdir(), 'xperiment-cli-'));
    process.env['XPERIMENT_HOME'] = old;
    writeFileSync(join(old, 'credentials.json'), JSON.stringify({ token: 'qs_from_before' }));
    saveToken('qs_current');
    clearToken();
    expect(loadToken()).toBeNull();
  });

  test('the old env var is still honoured', () => {
    process.env['XPERIMENT_TOKEN'] = 'qs_old_env';
    expect(loadToken()).toBe('qs_old_env');
  });
});
