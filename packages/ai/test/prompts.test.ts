import { connectorCatalog, createDefaultRegistry } from '@xperiment/connectors';
import { describe, expect, test } from 'vitest';
import { buildSystemPrompt, buildUserMessages, repairMessage, type CatalogEntry } from '../src/prompts.js';

const catalog = connectorCatalog(createDefaultRegistry()) as CatalogEntry[];
const connections = [
  { id: 'c-1', connectorKey: 'telegram', name: 'Team bot' },
  { id: 'c-2', connectorKey: 'postgres', name: 'Main DB' },
];

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt(catalog, connections);

  test('embeds the IR contract and every catalog node type', () => {
    expect(prompt).toContain('schemaVersion');
    expect(prompt).toContain('entrypoints');
    for (const entry of catalog) expect(prompt).toContain(entry.type);
  });

  test('lists available connections by id, key and name', () => {
    expect(prompt).toContain('c-1');
    expect(prompt).toContain('telegram');
    expect(prompt).toContain('Team bot');
  });

  test('names the expression roots and forbids inventing connections', () => {
    expect(prompt).toContain('trigger');
    expect(prompt).toContain('connectionRef');
  });

  test('handles an empty connection list gracefully', () => {
    expect(() => buildSystemPrompt(catalog, [])).not.toThrow();
    expect(buildSystemPrompt(catalog, [])).toContain('schemaVersion');
  });
});

describe('buildUserMessages', () => {
  test('generate mode carries just the prompt', () => {
    const msgs = buildUserMessages('kirim telegram saat ada lead');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toContain('kirim telegram saat ada lead');
  });

  test('edit mode includes the current IR JSON', () => {
    const currentIr = { schemaVersion: '0.1', nodes: [{ id: 'hook' }] };
    const msgs = buildUserMessages('add a filter', currentIr);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toContain('add a filter');
    expect(msgs[0]!.content).toContain('"hook"');
  });
});

describe('repairMessage', () => {
  test('carries the findings JSON as a user turn', () => {
    const msg = repairMessage([{ layer: 'graph', code: 'unknown_type', message: 'x' }]);
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('unknown_type');
    expect(msg.content.toLowerCase()).toContain('corrected');
  });
});
