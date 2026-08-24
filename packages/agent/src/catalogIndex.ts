import type { ConnectorCatalogItem } from '@xperiment/connectors';

/**
 * One line per node type, inlined in the instructions.
 *
 * The split matters. The old prompt shipped every parameter JSON Schema on every attempt —
 * 25,260 characters, resent three times per failed generation. Moving the schemas behind
 * `describe_node_type` cuts that by roughly an order of magnitude.
 *
 * But the *index* stays inline, deliberately. A model that can only discover node types by
 * calling a tool will sometimes not call it, and will invent something plausible instead —
 * which is precisely the `telegram_message_placeholder` failure. Having every type visible
 * makes `telegram.sendMessage` unmissable; having the schemas behind a tool keeps the
 * prompt from being eight kilobytes of JSON Schema.
 */
export function buildCatalogIndex(catalog: readonly ConnectorCatalogItem[]): string {
  return [...catalog]
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((c) => {
      const needs = c.requiresConnection ? ` — needs a ${c.requiresConnection} connection` : '';
      const ports = c.outputPorts.length > 0 ? ` [ports: ${c.outputPorts.join(', ')}]` : ' [no output ports]';
      return `${c.type} (${c.kind}) — ${c.description ?? c.displayName ?? ''}${needs}${ports}`;
    })
    .join('\n');
}
