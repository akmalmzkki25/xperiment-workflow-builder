import { validateWorkflow, type RegistryLike, type ValidationFinding, type WorkflowIR } from '@xperiment/ir';
import { extractJson } from './extract.js';
import type { ChatClient, ChatMessage } from './openrouter.js';
import { buildSystemPrompt, buildUserMessages, repairMessage, type CatalogEntry, type ConnectionSummary } from './prompts.js';

const DEFAULT_MAX_ATTEMPTS = 3;

export interface GenerateDeps {
  client: ChatClient;
  registry: RegistryLike;
  catalog: CatalogEntry[];
  connections: ConnectionSummary[];
  maxAttempts?: number;
}

export interface GenerateResult {
  ir?: WorkflowIR;
  findings: ValidationFinding[];
  attempts: number;
  tokensUsed: number;
}

export async function generateWorkflow(
  prompt: string,
  deps: GenerateDeps,
  currentIr?: unknown,
): Promise<GenerateResult> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const connectionSummaries = deps.connections.map((c) => ({ id: c.id, connectorKey: c.connectorKey }));
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(deps.catalog, deps.connections) },
    ...buildUserMessages(prompt, currentIr),
  ];

  let lastFindings: ValidationFinding[] = [];
  let tokensUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await deps.client.chat(messages);
    tokensUsed += res.usage.totalTokens;
    const content = res.content;

    let candidate: unknown;
    try {
      candidate = extractJson(content);
    } catch {
      lastFindings = [
        { layer: 'schema', code: 'not_json', message: 'Response was not valid JSON. Return only a JSON object.' },
      ];
      if (attempt < maxAttempts) {
        messages.push({ role: 'assistant', content }, repairMessage(lastFindings));
      }
      continue;
    }

    const result = validateWorkflow(candidate, { registry: deps.registry, connections: connectionSummaries });
    if (result.valid && result.ir) {
      return { ir: result.ir, findings: [], attempts: attempt, tokensUsed };
    }
    lastFindings = result.findings;
    if (attempt < maxAttempts) {
      messages.push({ role: 'assistant', content }, repairMessage(result.findings));
    }
  }

  return { findings: lastFindings, attempts: maxAttempts, tokensUsed };
}
