import { connectorCatalog, createDefaultRegistry } from '@xperiment/connectors';
import { createPool, getDraft, runMigrations } from '@xperiment/db';
import { validateWorkflow } from '@xperiment/ir';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { getTemplate, listTemplates } from '../src/templates/catalog.js';
import { createAuthedUser, type AuthedUser } from './authHelpers.js';

const registry = createDefaultRegistry();
const requiresByType = new Map(
  (connectorCatalog(registry) as { type: string; requiresConnection?: string }[]).map((c) => [c.type, c.requiresConnection]),
);

let pool: Pool;
let app: FastifyInstance;
let auth: AuthedUser;
beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  app = buildServer({ pool, registry: createDefaultRegistry() });
  auth = await createAuthedUser(app);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('template catalog', () => {
  test('ships at least three templates with unique ids', () => {
    const all = listTemplates();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  test('every template is valid IR with a webhook trigger and a whatsapp node', () => {
    for (const t of listTemplates()) {
      const result = validateWorkflow(t.definition, { registry });
      expect(result.valid, `${t.id}: ${JSON.stringify(result.findings)}`).toBe(true);
      const types = t.definition.nodes.map((n) => n.type);
      expect(types).toContain('webhook.trigger');
      expect(types).toContain('whatsapp.sendMessage');
    }
  });

  test('requiredConnectors equals the set of requiresConnection across nodes', () => {
    for (const t of listTemplates()) {
      const needed = [...new Set(t.definition.nodes.map((n) => requiresByType.get(n.type)).filter(Boolean))].sort();
      expect(t.requiredConnectors.slice().sort()).toEqual(needed);
    }
  });

  test('listTemplates filters by category and getTemplate resolves by id', () => {
    const sales = listTemplates('sales');
    expect(sales.every((t) => t.category === 'sales')).toBe(true);
    expect(getTemplate('wa-lead-auto-reply')?.category).toBe('sales');
    expect(getTemplate('nope')).toBeUndefined();
  });
});

describe('/v1/templates routes', () => {
  test('lists summaries without the IR and filters by category', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/templates' });
    expect(r.statusCode).toBe(200);
    const items = r.json<{ items: { id: string; definition?: unknown }[] }>().items;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]!.definition).toBeUndefined();
    const sales = await auth.inject({ method: 'GET', url: '/v1/templates?category=sales' });
    expect(sales.json<{ items: { category: string }[] }>().items.every((t) => t.category === 'sales')).toBe(true);
  });

  test('detail returns the IR; unknown id is 404', async () => {
    const r = await auth.inject({ method: 'GET', url: '/v1/templates/wa-lead-auto-reply' });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ definition: { nodes: unknown[] } }>().definition.nodes.length).toBeGreaterThan(0);
    expect((await auth.inject({ method: 'GET', url: '/v1/templates/nope' })).statusCode).toBe(404);
  });

  test('clone creates a workflow whose draft equals the template IR, scoped to the caller', async () => {
    const r = await auth.inject({ method: 'POST', url: '/v1/templates/wa-lead-auto-reply/clone', payload: { name: 'My WA flow' } });
    expect(r.statusCode).toBe(201);
    const id = r.json<{ id: string; name: string }>().id;
    expect(r.json<{ name: string }>().name).toBe('My WA flow');
    const draft = await getDraft(pool, id);
    expect(draft?.definition).toEqual(getTemplate('wa-lead-auto-reply')!.definition);
    const other = await createAuthedUser(app);
    expect((await other.inject({ method: 'GET', url: `/v1/workflows/${id}` })).statusCode).toBe(404);
  });

  test('cloning an unknown template is 404', async () => {
    expect((await auth.inject({ method: 'POST', url: '/v1/templates/nope/clone' })).statusCode).toBe(404);
  });
});
