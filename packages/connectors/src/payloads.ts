import { z } from 'zod';

export const CONNECTION_PAYLOAD_SCHEMAS = {
  postgres: z.object({ connectionString: z.string().min(1) }).strict(),
  telegram: z.object({ botToken: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  openai: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  gemini: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
} as const;

export type ConnectorKey = keyof typeof CONNECTION_PAYLOAD_SCHEMAS;
