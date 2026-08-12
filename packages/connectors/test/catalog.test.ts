import { describe, expect, test } from 'vitest';
import { connectorCatalog } from '../src/catalog.js';
import { createDefaultRegistry } from '../src/registry.js';

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, { enum?: unknown[]; type?: string }>;
  required?: string[];
}

describe('connectorCatalog', () => {
  const registry = createDefaultRegistry();
  const items = connectorCatalog(registry);
  const byType = new Map(items.map((i) => [i.type, i]));

  test('lists every registered connector with metadata only', () => {
    // The invariant is that the catalog is a faithful projection of the registry.
    // A hard count was the same edit in two files every time a connector landed.
    expect(items.map((i) => i.type).sort()).toEqual(registry.list().map((d) => d.type).sort());
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        expect.arrayContaining(['defaultEffectClass', 'kind', 'operationVersion', 'outputPorts', 'paramsJsonSchema', 'type']),
      );
      expect(item).not.toHaveProperty('run');
      expect(item).not.toHaveProperty('paramsSchema');
      expect(item).not.toHaveProperty('testConnection');
    }
  });

  test('webhook.trigger params serialize authMode enum', () => {
    const schema = byType.get('webhook.trigger')?.paramsJsonSchema as JsonSchemaObject;
    expect(schema.type).toBe('object');
    expect(schema.properties?.['authMode']?.enum).toEqual(expect.arrayContaining(['none']));
  });

  test('requiresConnection surfaces only where defined', () => {
    expect(byType.get('telegram.sendMessage')?.requiresConnection).toBe('telegram');
    expect(byType.get('postgres.query')?.requiresConnection).toBe('postgres');
    expect(byType.get('http.request')?.requiresConnection).toBeUndefined();
    expect(byType.get('core.transform')?.requiresConnection).toBeUndefined();
  });

  test('if node exposes true/false output ports', () => {
    expect(byType.get('core.if')?.outputPorts).toEqual(['true', 'false']);
  });

  test('every connector carries a display name, description, category and glyph', () => {
    for (const item of items) {
      expect(item.displayName.length, item.type).toBeGreaterThan(0);
      expect(item.description.length, item.type).toBeGreaterThan(0);
      expect(item.category.length, item.type).toBeGreaterThan(0);
      // One character on the node, not a word.
      expect([...item.glyph], item.type).toHaveLength(1);
    }
  });

  test('a display name never repeats the raw type', () => {
    // 'whatsapp.sendMessage' in the palette is the thing this replaces.
    for (const item of items) expect(item.displayName, item.type).not.toBe(item.type);
  });

  test('no two connectors share a display name', () => {
    const names = items.map((i) => i.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  test('a description reads as a sentence, not a label', () => {
    for (const item of items) {
      expect(item.description.endsWith('.'), item.type).toBe(true);
      expect(item.description.length, item.type).toBeGreaterThan(20);
    }
  });

  test('every category is one the palette knows how to group', () => {
    const known = new Set(['Triggers', 'Logic', 'Data', 'Messaging', 'AI', 'Payments', 'Integrations']);
    for (const item of items) expect(known.has(item.category), `${item.type}: ${item.category}`).toBe(true);
  });

  test('docsUrl, where present, is an https URL', () => {
    for (const item of items) {
      if (item.docsUrl !== undefined) expect(item.docsUrl.startsWith('https://'), item.type).toBe(true);
    }
  });

  test('approval node exposes approved/rejected ports', () => {
    expect(byType.get('core.approval')?.outputPorts).toEqual(['approved', 'rejected']);
    expect(byType.get('core.delay')?.requiresConnection).toBeUndefined();
  });
});
