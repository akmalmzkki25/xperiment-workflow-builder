import { describe, expect, test } from 'vitest';
import { filterCatalog, matchesQuery, type SearchableItem } from '../src/lib/catalogSearch';
import { groupFindingsByNode, isFocusable, WORKFLOW_LEVEL } from '../src/lib/findings';
import type { Finding } from '../src/lib/api';

const item = (type: string, extra: Partial<SearchableItem> = {}): SearchableItem => ({ type, ...extra });

const CATALOG: SearchableItem[] = [
  item('whatsapp.sendMessage', { kind: 'action' }),
  item('core.if', { kind: 'logic' }),
  item('core.loop', { kind: 'logic' }),
  item('webhook.trigger', { kind: 'trigger' }),
];

describe('matchesQuery', () => {
  test('an empty query matches everything', () => {
    expect(matchesQuery(item('core.if'), '')).toBe(true);
    expect(matchesQuery(item('core.if'), '   ')).toBe(true);
  });

  test('every token must appear, in any order and any field', () => {
    // A single substring match over the raw type would miss this: nobody types a
    // connector id with the dot in the right place.
    expect(matchesQuery(CATALOG[0]!, 'send whats')).toBe(true);
    expect(matchesQuery(CATALOG[0]!, 'whats send')).toBe(true);
    expect(matchesQuery(CATALOG[0]!, 'send telegram')).toBe(false);
  });

  test('is case insensitive', () => {
    expect(matchesQuery(CATALOG[0]!, 'SENDMESSAGE')).toBe(true);
  });

  test('searches the kind as well as the type', () => {
    expect(matchesQuery(CATALOG[3]!, 'trigger')).toBe(true);
  });

  test('reads display metadata when the catalog carries it', () => {
    const rich = item('core.if', { displayName: 'Branch', description: 'Route on a condition', category: 'Logic' });
    expect(matchesQuery(rich, 'branch')).toBe(true);
    expect(matchesQuery(rich, 'condition')).toBe(true);
    expect(matchesQuery(rich, 'logic route')).toBe(true);
  });

  test('works before the catalog carries any display metadata', () => {
    // The whole reason every field is optional: this must not wait on the catalog.
    expect(matchesQuery(item('core.if'), 'core')).toBe(true);
    expect(matchesQuery(item('core.if'), 'branch')).toBe(false);
  });
});

describe('filterCatalog', () => {
  test('an empty query returns a copy of everything, not the same array', () => {
    const out = filterCatalog(CATALOG, '');
    expect(out).toHaveLength(CATALOG.length);
    expect(out).not.toBe(CATALOG);
  });

  test('narrows to the matches and preserves order', () => {
    expect(filterCatalog(CATALOG, 'core').map((i) => i.type)).toEqual(['core.if', 'core.loop']);
  });

  test('no match is an empty list, not everything', () => {
    expect(filterCatalog(CATALOG, 'zzz')).toHaveLength(0);
  });
});

const finding = (code: string, nodeId?: string): Finding => ({
  layer: 'graph',
  code,
  message: `${code} happened`,
  ...(nodeId ? { nodeId } : {}),
});

describe('findings', () => {
  test('groups by node and keeps workflow-level findings under their own key', () => {
    const map = groupFindingsByNode([finding('a', 'n1'), finding('b'), finding('c', 'n1')]);
    expect(map.get('n1')).toHaveLength(2);
    expect(map.get(WORKFLOW_LEVEL)).toHaveLength(1);
  });

  test('an empty list groups to an empty map', () => {
    expect(groupFindingsByNode([]).size).toBe(0);
  });

  test('only a finding naming a node can be flown to', () => {
    expect(isFocusable(finding('a', 'n1'))).toBe(true);
    expect(isFocusable(finding('b'))).toBe(false);
    // A button that goes nowhere is worse than plain text.
    expect(isFocusable({ ...finding('c'), nodeId: '' })).toBe(false);
  });
});
