import { describe, expect, test } from 'vitest';
import { formatBytes, previewPayload } from '../src/lib/payloadView';

describe('previewPayload', () => {
  test('pretty-prints an object and reports its size', () => {
    const p = previewPayload({ url: 'https://x.test', headers: { accept: 'application/json' } });
    expect(p.empty).toBe(false);
    expect(p.truncated).toBe(false);
    expect(p.text).toContain('"url": "https://x.test"');
    expect(p.text.split('\n').length).toBeGreaterThan(1);
    expect(p.bytes).toBe(p.text.length);
  });

  test('truncates past the cap and flags it', () => {
    // A node payload can be 256 KiB and several attempts render at once.
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, label: `row ${i}` })) };
    const p = previewPayload(big, 500);
    expect(p.truncated).toBe(true);
    expect(p.text.endsWith('… truncated')).toBe(true);
    expect(p.text.length).toBeLessThan(600);
    // bytes reports the FULL size, so the UI can say how much was hidden.
    expect(p.bytes).toBeGreaterThan(500);
  });

  test('reports null and undefined as empty rather than as the text null', () => {
    // "Not recorded" and "recorded null" look the same to JSON.stringify but not to
    // an operator asking why a node produced nothing.
    expect(previewPayload(null)).toMatchObject({ empty: true, text: '' });
    expect(previewPayload(undefined)).toMatchObject({ empty: true, text: '' });
  });

  test('an empty object is NOT empty — the node recorded something', () => {
    expect(previewPayload({})).toMatchObject({ empty: false, text: '{}' });
    expect(previewPayload([])).toMatchObject({ empty: false, text: '[]' });
  });

  test('renders primitives and survives an unrenderable value', () => {
    expect(previewPayload(0).text).toBe('0');
    expect(previewPayload(false).text).toBe('false');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(previewPayload(cyclic).text).toBe('[unrenderable value]');
  });
});

describe('formatBytes', () => {
  test('scales through bytes, kilobytes and megabytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
