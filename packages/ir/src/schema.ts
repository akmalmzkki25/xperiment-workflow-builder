import { z } from 'zod';

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    strategy: z.literal('exponential-jitter').optional(),
    initialDelayMs: z.number().int().min(0).optional(),
    maxDelayMs: z.number().int().min(0).optional(),
    retryOn: z.array(z.union([z.number().int(), z.literal('timeout')])).optional(),
  })
  .strict();

export const irNodeSchema = z
  .object({
    id: z.string().regex(idPattern, 'node id must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
    kind: z.enum(['trigger', 'action', 'logic']),
    type: z.string().min(1),
    operationVersion: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    settings: z
      .object({
        timeoutMs: z.number().int().min(1).max(300000).optional(),
        retry: retryPolicySchema.optional(),
      })
      .strict()
      .optional(),
    effectClass: z.enum(['pure', 'read', 'write']).optional(),
    connectionRef: z.string().uuid().optional(),
  })
  .strict();

export const irEdgeSchema = z
  .object({
    id: z.string().regex(idPattern),
    from: z.object({ nodeId: z.string(), port: z.string().min(1) }).strict(),
    to: z.object({ nodeId: z.string(), port: z.string().min(1) }).strict(),
  })
  .strict();

export const workflowIrSchema = z
  .object({
    schemaVersion: z.literal('0.1'),
    workflow: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    entrypoints: z.array(z.string()).min(1),
    nodes: z.array(irNodeSchema).min(1),
    edges: z.array(irEdgeSchema),
    metadata: z
      .object({
        executionTimeoutMs: z.number().int().min(1000).max(86400000).optional(),
        layout: z
          .record(z.string(), z.object({ x: z.number(), y: z.number() }).strict())
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
