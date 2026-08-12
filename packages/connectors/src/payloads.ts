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
      // Coerced so the web form (which submits strings) validates cleanly.
      port: z.coerce.number().int().min(1).max(65535),
      user: z.string().min(1),
      password: z.string().min(1),
      from: z.string().min(1),
      // A real JSON boolean, or the web form's "true"/"false" string. NOT
      // z.coerce.boolean(), which turns any non-empty string (incl. "false") into true.
      secure: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
    })
    .strict(),
  slack: z.object({ botToken: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  // Midtrans authenticates with the server key as the Basic username and an empty
  // password. The client key is a browser-side value and is deliberately not stored here.
  midtrans: z.object({ serverKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
  xendit: z.object({ secretKey: z.string().min(1), baseUrl: z.string().url().optional() }).strict(),
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
