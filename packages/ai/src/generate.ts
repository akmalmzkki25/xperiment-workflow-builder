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
  /**
   * Epoch ms after which no further attempt is started. The client's per-call timeout
   * bounds one call; this bounds the run, so three repair attempts against a slow
   * provider cannot add up to three timeouts in series.
   */
  deadlineAt?: number;
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
    // Checked before the call, not after: the point is not to start work we already know
    // there is no time to finish.
    if (attempt > 1 && deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) {
      return { findings: lastFindings, attempts: attempt - 1, tokensUsed };
    }
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
