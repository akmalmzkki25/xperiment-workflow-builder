import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { clearToken, loadToken, saveToken } from '../src/auth.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xperiment-cli-'));
  process.env['XPERIMENT_HOME'] = home;
  delete process.env['XPERIMENT_TOKEN'];
});
afterEach(() => {
  delete process.env['XPERIMENT_HOME'];
  delete process.env['XPERIMENT_TOKEN'];
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
