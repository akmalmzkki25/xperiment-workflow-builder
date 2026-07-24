import { coreIf } from './core/if.js';
import { coreTransform } from './core/transform.js';
import { createHttpRequest } from './http/request.js';
import { geminiGenerate } from './gemini/generate.js';
import { manualTrigger } from './manual/trigger.js';
import { openaiChat } from './openai/chat.js';
import { postgresQuery } from './postgres/query.js';
import { telegramSendMessage } from './telegram/sendMessage.js';
import { scheduleTrigger } from './schedule/trigger.js';
import { webhookTrigger } from './webhook/trigger.js';
import type { ConnectorDefinition } from './types.js';

export interface ConnectorRegistry {
  get(type: string): ConnectorDefinition | undefined;
  list(): ConnectorDefinition[];
}

export interface RegistryConfig {
  allowPrivateIps?: boolean;
}

export function createDefaultRegistry(cfg: RegistryConfig = {}): ConnectorRegistry {
  const defs: ConnectorDefinition[] = [
    manualTrigger,
    webhookTrigger,
    scheduleTrigger,
    coreTransform,
    coreIf,
    createHttpRequest({ allowPrivateIps: cfg.allowPrivateIps ?? false }),
    postgresQuery,
    telegramSendMessage,
    openaiChat,
    geminiGenerate,
  ];
  const byType = new Map(defs.map((d) => [d.type, d]));
  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
  };
}
