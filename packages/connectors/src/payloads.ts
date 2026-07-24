import { z } from 'zod';

export const CONNECTION_PAYLOAD_SCHEMAS = {
  postgres: z.object({ connectionString: z.string().min(1) }).strict(),
  telegram: z.object({ botToken: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  openai: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  gemini: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  whatsapp: z
    .object({
      accessToken: z.string().min(1),
      phoneNumberId: z.string().min(1),
      baseUrl: z.string().url().optional(),
    })
    .strict(),
  smtp: z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      user: z.string().min(1),
      password: z.string().min(1),
      from: z.string().min(1),
      secure: z.boolean().optional(),
    })
    .strict(),
  googleSheets: z
    .object({
      serviceAccountEmail: z.string().email(),
      privateKey: z.string().min(1),
      baseUrl: z.string().url().optional(),
      tokenUrl: z.string().url().optional(),
      testSpreadsheetId: z.string().optional(),
    })
    .strict(),
} as const;

export type ConnectorKey = keyof typeof CONNECTION_PAYLOAD_SCHEMAS;
