import { buildServer } from '@xperiment/api';
import { createDefaultRegistry } from '@xperiment/connectors';
import { createPool, runMigrations } from '@xperiment/db';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ApiClient, ApiError } from '../src/client.js';

let pool: Pool;
let app: FastifyInstance;
let client: ApiClient;
let baseUrl: string;

const minimalIr = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_min', name: 'Min' },
  entrypoints: ['t'],
  nodes: [{ id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} }],
  edges: [],
};

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry({ allowPrivateIps: true }) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  client = new ApiClient(baseUrl);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
});

describe('ApiClient', () => {
  test('full lifecycle: register, create, draft, validate, publish, execute, inspect', async () => {
    const { token } = await client.register(`cli-${Date.now()}@xperiment.test`, 'password-123');
    client.setToken(token);
    const wf = await client.createWorkflow('CLI test');
    await client.updateDraft(wf.id, minimalIr, 1);
    const validation = await client.validate(wf.id);
    expect(validation.valid).toBe(true);
    const version = await client.publish(wf.id);
    expect(version.versionNumber).toBe(1);
    const exec = await client.execute(wf.id, { hello: true }, 'cli-key-1');
    expect(exec.created).toBe(true);
    const detail = await client.getExecution(exec.executionId);
    expect(detail.execution.status).toBe('CREATED');
    const list = await client.listWorkflows();
    expect(list.items).toHaveLength(1);
  });

  test('problem responses throw ApiError with status and body', async () => {
    const err = await client.getWorkflow('00000000-0000-0000-0000-0000000000dd').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  test('unauthenticated client gets 401', async () => {
    const anon = new ApiClient(baseUrl);
    const err = await anon.listWorkflows().catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(401);
  });
});
