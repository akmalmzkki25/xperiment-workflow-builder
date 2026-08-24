import { AiProviderError } from './errors.js';

export { AiProviderError } from './errors.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  /** Origin only, e.g. https://openrouter.ai — the client appends /api/v1/chat/completions. */
  baseUrl: string;
  appUrl?: string;
  appTitle?: string;
  /** Per-call wall clock. Without one, a provider that accepts the socket and then says
   *  nothing holds this request — and the Fastify request behind it — open forever. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Generous: a long completion against a busy model legitimately takes tens of seconds. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
}

export interface ChatClient {
  chat(messages: ChatMessage[], opts?: { responseSchema?: unknown }): Promise<ChatResult>;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function createOpenRouterClient(cfg: OpenRouterConfig): ChatClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v1/chat/completions`;
  return {
    async chat(messages, opts) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      };
      if (cfg.appUrl) headers['http-referer'] = cfg.appUrl;
      if (cfg.appTitle) headers['x-title'] = cfg.appTitle;
      const body: Record<string, unknown> = { model: cfg.model, messages };
      if (opts?.responseSchema !== undefined) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: { name: 'workflow', strict: true, schema: opts.responseSchema },
        };
      }
      let res: Response;
      const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // A timeout is worth telling apart from a refused connection: one means the
        // provider is slow, the other that it is gone, and they call for different
        // responses from whoever reads the log.
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        // Never surface the underlying error text — it can echo request headers.
        throw new AiProviderError(null, timedOut ? `AI provider timed out after ${timeoutMs}ms` : 'AI provider request failed');
      }
      if (!res.ok) {
        throw new AiProviderError(res.status, `AI provider returned ${res.status}`);
      }
      const data = (await res.json()) as ChatCompletion;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new AiProviderError(null, 'AI provider returned no completion');
      }
      const u = data.usage ?? {};
      return {
        content,
        usage: {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
        },
      };
    },
  };
}
