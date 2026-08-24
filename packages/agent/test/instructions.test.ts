import { connectorCatalog, createDefaultRegistry } from '@xperiment/connectors';
import { describe, expect, test } from 'vitest';
import { buildCatalogIndex } from '../src/catalogIndex.js';
import { buildInstructions } from '../src/instructions.js';

const catalog = connectorCatalog(createDefaultRegistry({ allowPrivateIps: false }));
const index = buildCatalogIndex(catalog);

const withNoConnections = () => buildInstructions({ catalogIndex: index, connections: [] });
const withTelegram = () =>
  buildInstructions({ catalogIndex: index, connections: [{ id: 'c-1', connectorKey: 'telegram', name: 'Toko bot' }] });

describe('buildCatalogIndex', () => {
  test('names every node type, so the model never has to guess one exists', () => {
    // The placeholder bug was a model that knew what it wanted and could not see the node.
    for (const entry of catalog) expect(index, entry.type).toContain(entry.type);
  });

  test('marks which node types need a credential, in words', () => {
    const telegram = index.split('\n').find((l) => l.startsWith('telegram.sendMessage'));
    expect(telegram).toBeDefined();
    expect(telegram).toContain('telegram');
    expect(telegram!.toLowerCase()).toContain('connection');
  });

  test('carries a description, not just a dotted identifier', () => {
    const line = index.split('\n').find((l) => l.startsWith('schedule.trigger'));
    expect(line!.length).toBeGreaterThan('schedule.trigger'.length + 20);
  });

  test('stays small enough to inline — the JSON Schemas live behind a tool', () => {
    // The old prompt shipped every parameter schema on every attempt: 25,260 characters.
    expect(index.length).toBeLessThan(6000);
  });
});

describe('buildInstructions', () => {
  test('an empty workspace does NOT restrict which nodes may be used', () => {
    // This is the defect, as a literal string. The old prompt said
    // "None. Do not use any node that requiresConnection." and the model obeyed by
    // substituting a core.transform named telegram_message_placeholder.
    const text = withNoConnections();
    expect(text).toContain('does not restrict which nodes you may use');
    expect(text).not.toContain('Do not use any node');
  });

  test('it says what to do instead: build correctly, then ask for the credential', () => {
    const text = withNoConnections();
    expect(text).toContain('connectionRef');
    expect(text.toLowerCase()).toContain('request_credential');
  });

  test('placeholder nodes are forbidden by name', () => {
    const text = withNoConnections();
    for (const word of ['placeholder', 'todo', 'stub']) expect(text.toLowerCase()).toContain(word);
  });

  test('it lists the connections a workspace does have, by name and key', () => {
    const text = withTelegram();
    expect(text).toContain('Toko bot');
    expect(text).toContain('c-1');
  });

  test('it states plainly that it cannot publish or activate', () => {
    // A model told it cannot behaves far better than one that finds no tool and improvises.
    const text = withNoConnections();
    expect(text.toLowerCase()).toContain('cannot publish');
    expect(text.toLowerCase()).toContain('activate');
  });

  test('it forbids asking for a secret in the conversation', () => {
    const text = withNoConnections();
    expect(text.toLowerCase()).toContain('never ask');
    expect(text.toLowerCase()).toContain('connection form');
  });

  test('it carries the cross-field rules no parameter schema can express', () => {
    const text = withNoConnections();
    expect(text).toContain('whatsapp.sendMessage');
    expect(text).toContain('core.switch');
    expect(text).toContain('core.aggregate');
  });

  test('it names the expression roots and no others', () => {
    const text = withNoConnections();
    expect(text).toContain('{{ trigger.body.field }}');
    expect(text).toContain('{{ nodes.');
    expect(text).toContain('{{ execution.id }}');
  });
});
