import { connectorCatalog, createDefaultRegistry } from '@xperiment/connectors';
import { beforeEach, describe, expect, test } from 'vitest';
import { generateWorkflow } from '../src/generate.js';
import type { ChatClient, ChatMessage } from '../src/openrouter.js';
import type { CatalogEntry } from '../src/prompts.js';

const registry = createDefaultRegistry();
const catalog = connectorCatalog(registry) as CatalogEntry[];

function validIr(name = 'AI flow'): unknown {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_ai', name },
    entrypoints: ['hook'],
    nodes: [
      { id: 'hook', kind: 'trigger', type: 'webhook.trigger', operationVersion: '0.1.0', parameters: { authMode: 'none' } },
      {
        id: 'shape',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { ok: true } },
      },
    ],
    edges: [{ id: 'e_hook_main_shape', from: { nodeId: 'hook', port: 'main' }, to: { nodeId: 'shape', port: 'input' } }],
  };
}

const USAGE_PER_CALL = 7; // fixed per-call token cost so tokensUsed accumulation is assertable

/** ChatClient that returns queued strings in order, recording the messages it saw. */
function scriptedClient(responses: string[]): { client: ChatClient; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const client: ChatClient = {
    async chat(messages) {
      seen.push(messages);
      const r = responses[i] ?? '{}';
      i += 1;
      return { content: r, usage: { promptTokens: 4, completionTokens: 3, totalTokens: USAGE_PER_CALL } };
    },
  };
  return { client, seen };
}

let deps: Parameters<typeof generateWorkflow>[1];
beforeEach(() => {
  deps = { client: scriptedClient([]).client, registry, catalog, connections: [] };
});

describe('generateWorkflow', () => {
  test('returns the IR on a first valid completion', async () => {
    const { client } = scriptedClient([JSON.stringify(validIr())]);
    const result = await generateWorkflow('build it', { ...deps, client });
    expect(result.attempts).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.ir?.nodes).toHaveLength(2);
  });

  test('accumulates tokensUsed across attempts', async () => {
    const broken = { schemaVersion: '0.1', workflow: { id: 'w', name: 'n' }, entrypoints: ['ghost'], nodes: [], edges: [] };
    const { client } = scriptedClient([JSON.stringify(broken), JSON.stringify(validIr())]);
    const result = await generateWorkflow('build it', { ...deps, client });
    expect(result.attempts).toBe(2);
    expect(result.tokensUsed).toBe(USAGE_PER_CALL * 2); // one call per attempt
  });

  test('repairs an invalid draft then succeeds, feeding findings back', async () => {
    const broken = { schemaVersion: '0.1', workflow: { id: 'w', name: 'n' }, entrypoints: ['ghost'], nodes: [], edges: [] };
    const { client, seen } = scriptedClient([JSON.stringify(broken), JSON.stringify(validIr())]);
    const result = await generateWorkflow('build it', { ...deps, client });
    expect(result.attempts).toBe(2);
    expect(result.ir).toBeDefined();
    // the second turn must include the assistant's bad output + a repair user turn with findings
    expect(seen[1]!.some((m) => m.role === 'assistant')).toBe(true);
    expect(seen[1]!.some((m) => m.role === 'user' && m.content.toLowerCase().includes('corrected'))).toBe(true);
  });

  test('gives up after the attempt cap with findings and no ir', async () => {
    const bad = JSON.stringify({ schemaVersion: '0.1', workflow: { id: 'w', name: 'n' }, entrypoints: [], nodes: [], edges: [] });
    const { client } = scriptedClient([bad, bad, bad, bad]);
    const result = await generateWorkflow('build it', { ...deps, client });
    expect(result.attempts).toBe(3);
    expect(result.ir).toBeUndefined();
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test('treats a non-JSON completion as a repairable failure', async () => {
    const { client } = scriptedClient(['I cannot do that', JSON.stringify(validIr())]);
    const result = await generateWorkflow('build it', { ...deps, client });
    expect(result.attempts).toBe(2);
    expect(result.ir).toBeDefined();
  });

  test('respects a custom maxAttempts', async () => {
    const bad = '{}';
    const { client } = scriptedClient([bad, bad, bad, bad, bad]);
    const result = await generateWorkflow('build it', { ...deps, client, maxAttempts: 2 });
    expect(result.attempts).toBe(2);
    expect(result.ir).toBeUndefined();
  });
});
