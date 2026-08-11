import { describe, expect, test } from 'vitest';
import { mergeEnv, parseEnvFile } from '../src/env.js';

describe('parseEnvFile', () => {
  test('reads plain assignments', () => {
    expect(parseEnvFile('API_PORT=3000\nGATEWAY_PORT=3003')).toEqual({ API_PORT: '3000', GATEWAY_PORT: '3003' });
  });

  test('skips comments and blank lines', () => {
    expect(parseEnvFile('# a note\n\nFOO=1\n   \n# another')).toEqual({ FOO: '1' });
  });

  test('handles CRLF, because this file is edited on Windows', () => {
    expect(parseEnvFile('FOO=1\r\nBAR=2\r\n')).toEqual({ FOO: '1', BAR: '2' });
  });

  test('accepts an export prefix', () => {
    expect(parseEnvFile('export FOO=1')).toEqual({ FOO: '1' });
  });

  test('only the first equals splits, so URLs and base64 survive', () => {
    // A key ending in `=` padding truncated at the wrong `=` fails to decrypt anything,
    // and the error surfaces nowhere near this parser.
    const parsed = parseEnvFile('DATABASE_URL=postgresql://u:p@h:5432/db?sslmode=require\nKEK=YWJjZA==');
    expect(parsed['DATABASE_URL']).toBe('postgresql://u:p@h:5432/db?sslmode=require');
    expect(parsed['KEK']).toBe('YWJjZA==');
  });

  test('strips matching quotes but keeps a hash inside them', () => {
    expect(parseEnvFile('A="hello # world"')).toEqual({ A: 'hello # world' });
    expect(parseEnvFile("B='x y'")).toEqual({ B: 'x y' });
  });

  test('drops a trailing comment from an unquoted value', () => {
    expect(parseEnvFile('PORT=3000 # the api')).toEqual({ PORT: '3000' });
  });

  test('an empty value is a value', () => {
    expect(parseEnvFile('METRICS_TOKEN=')).toEqual({ METRICS_TOKEN: '' });
  });

  test('ignores lines that are not assignments', () => {
    expect(parseEnvFile('just some prose\n=novalue\n1BAD=x\nOK=y')).toEqual({ OK: 'y' });
  });

  test('does not interpolate, so meaning never depends on the reading shell', () => {
    expect(parseEnvFile('A=$HOME/x')).toEqual({ A: '$HOME/x' });
  });
});

describe('mergeEnv', () => {
  test('the ambient environment wins', () => {
    // A CI job that exported DATABASE_URL must not be overridden by a .env somebody left
    // in their checkout — that is how a pipeline writes to the wrong database.
    const merged = mergeEnv({ DATABASE_URL: 'file' }, { DATABASE_URL: 'real' });
    expect(merged['DATABASE_URL']).toBe('real');
  });

  test('an explicit empty string still wins, because somebody typed it', () => {
    expect(mergeEnv({ TOKEN: 'from-file' }, { TOKEN: '' })['TOKEN']).toBe('');
  });

  test('an unset variable falls through to the file', () => {
    expect(mergeEnv({ ONLY_IN_FILE: 'x' }, { OTHER: 'y' })['ONLY_IN_FILE']).toBe('x');
  });

  test('an undefined value does not clobber the file', () => {
    expect(mergeEnv({ A: 'file' }, { A: undefined })['A']).toBe('file');
  });

  test('never mutates either input', () => {
    const file = { A: '1' };
    const proc = { B: '2' };
    mergeEnv(file, proc);
    expect(file).toEqual({ A: '1' });
    expect(proc).toEqual({ B: '2' });
  });
});
