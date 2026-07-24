import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { clearToken, getToken, getWorkspace, setToken, setWorkspace } from '../src/lib/auth';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('auth token store', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  test('round-trips token and workspace', () => {
    expect(getToken()).toBeNull();
    setToken('qs_abc');
    setWorkspace('ws-1');
    expect(getToken()).toBe('qs_abc');
    expect(getWorkspace()).toBe('ws-1');
  });

  test('clearToken removes token and workspace', () => {
    setToken('qs_abc');
    setWorkspace('ws-1');
    clearToken();
    expect(getToken()).toBeNull();
    expect(getWorkspace()).toBeNull();
  });

  test('is a no-op without localStorage (SSR)', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(getToken()).toBeNull();
    expect(getWorkspace()).toBeNull();
    expect(() => setToken('x')).not.toThrow();
    expect(() => setWorkspace('y')).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });
});
