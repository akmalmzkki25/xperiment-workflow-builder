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
  fetchImpl?: typeof fetch;
}

export interface ChatClient {
  chat(messages: ChatMessage[], opts?: { responseSchema?: unknown }): Promise<string>;
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

export function createOpenRouterClient(cfg: OpenRouterConfig): ChatClient {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl}/api/v1/chat/completions`;
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
      try {
        res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch {
        // Never surface the underlying error text — it can echo request headers.
        throw new AiProviderError(null, 'AI provider request failed');
      }
      if (!res.ok) {
        throw new AiProviderError(res.status, `AI provider returned ${res.status}`);
      }
      const data = (await res.json()) as ChatCompletion;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new AiProviderError(null, 'AI provider returned no completion');
      }
      return content;
    },
  };
}
