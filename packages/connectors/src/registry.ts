import { coreApproval } from './core/approval.js';
import { coreDelay } from './core/delay.js';
import { coreIf } from './core/if.js';
import { coreLoop } from './core/loop.js';
import { coreSwitch } from './core/switch.js';
import { coreFilter } from './core/filter.js';
import { coreSort } from './core/sort.js';
import { coreLimit } from './core/limit.js';
import { coreTransform } from './core/transform.js';
import { coreWaitForEvent } from './core/waitForEvent.js';
import { createHttpRequest } from './http/request.js';
import { geminiGenerate } from './gemini/generate.js';
import { manualTrigger } from './manual/trigger.js';
import { openaiChat } from './openai/chat.js';
import { postgresQuery } from './postgres/query.js';
import { emailSend } from './email/send.js';
import { sheetsAppendRow } from './google/sheetsAppendRow.js';
import { sheetsGetRows } from './google/sheetsGetRows.js';
import { telegramSendMessage } from './telegram/sendMessage.js';
import { whatsappSendMessage } from './whatsapp/sendMessage.js';
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
    coreSwitch,
    coreFilter,
    coreSort,
    coreLimit,
    coreDelay,
    coreWaitForEvent,
    coreApproval,
    coreLoop,
    createHttpRequest({ allowPrivateIps: cfg.allowPrivateIps ?? false }),
    postgresQuery,
    telegramSendMessage,
    whatsappSendMessage,
    emailSend,
    sheetsAppendRow,
    sheetsGetRows,
    openaiChat,
    geminiGenerate,
  ];
  const byType = new Map(defs.map((d) => [d.type, d]));
  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
  };
}
