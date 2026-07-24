import { describe, expect, test } from 'vitest';
import { AiProviderError, createOpenRouterClient, type ChatMessage } from '../src/openrouter.js';

interface Captured {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'make a workflow' },
];

const completion = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

describe('createOpenRouterClient', () => {
  test('posts to the chat-completions endpoint with auth + app headers', async () => {
    const { fetchImpl, calls } = fakeFetch(200, completion('{"ok":true}'));
    const client = createOpenRouterClient({
      apiKey: 'sk-secret-xyz',
      model: 'google/gemini-3.1-flash-lite',
      baseUrl: 'https://openrouter.ai',
      appUrl: 'https://xperiment.local',
      appTitle: 'Xperiment',
      fetchImpl,
    });
    const out = await client.chat(messages);
    expect(out).toBe('{"ok":true}');
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-secret-xyz');
    expect(headers.get('http-referer')).toBe('https://xperiment.local');
    expect(headers.get('x-title')).toBe('Xperiment');
    const sent = JSON.parse(String(calls[0]!.init.body)) as { model: string; messages: unknown; response_format?: unknown };
    expect(sent.model).toBe('google/gemini-3.1-flash-lite');
    expect(sent.messages).toEqual(messages);
    expect(sent.response_format).toBeUndefined();
  });

  test('includes strict json_schema response_format only when a schema is passed', async () => {
    const { fetchImpl, calls } = fakeFetch(200, completion('{}'));
    const client = createOpenRouterClient({ apiKey: 'k', model: 'm', baseUrl: 'https://openrouter.ai', fetchImpl });
    await client.chat(messages, { responseSchema: { type: 'object' } });
    const sent = JSON.parse(String(calls[0]!.init.body)) as {
      response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
    };
    expect(sent.response_format.type).toBe('json_schema');
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema).toEqual({ type: 'object' });
  });

  test('raises AiProviderError on non-2xx without leaking the key', async () => {
    const { fetchImpl } = fakeFetch(429, { error: { message: 'rate limited for sk-secret-xyz' } });
    const client = createOpenRouterClient({ apiKey: 'sk-secret-xyz', model: 'm', baseUrl: 'https://openrouter.ai', fetchImpl });
    const err = await client.chat(messages).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).status).toBe(429);
    expect((err as AiProviderError).message).not.toContain('sk-secret-xyz');
  });

  test('raises AiProviderError when the completion has no content', async () => {
    const { fetchImpl } = fakeFetch(200, { choices: [] });
    const client = createOpenRouterClient({ apiKey: 'k', model: 'm', baseUrl: 'https://openrouter.ai', fetchImpl });
    await expect(client.chat(messages)).rejects.toBeInstanceOf(AiProviderError);
  });

  test('wraps network failures as AiProviderError with null status', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    const client = createOpenRouterClient({ apiKey: 'k', model: 'm', baseUrl: 'https://openrouter.ai', fetchImpl });
    const err = await client.chat(messages).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).status).toBeNull();
  });
});
