import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  createAlertRule,
  createPool,
  deriveTriggerKey,
  encryptSecret,
  fireAlert,
  listAlertEvents,
  runMigrations,
  withTx,
} from '@xperiment/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runAlertDelivery, type AlertDeliveryDeps } from '../src/alertDelivery.js';

const WS = '00000000-0000-0000-0000-000000000001';
const alertKey = deriveTriggerKey('xperiment-dev-trigger-secret-change-me');
let pool: Pool;
let deps: AlertDeliveryDeps;
let server: Server;
let baseUrl: string;
let received: { sig: string | undefined; body: unknown }[] = [];
let respStatus = 200;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  deps = { pool, alertKey, allowPrivateIps: true, log: () => {} };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      received.push({ sig: req.headers['x-xperiment-signature'] as string | undefined, body: JSON.parse(raw) });
      res.statusCode = respStatus;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE alert_events, alert_rules CASCADE`);
  received = [];
  respStatus = 200;
});

async function seedFiring(url: string | null, secret: string | null): Promise<{ ruleId: string; eventId: string }> {
  const rule = await createAlertRule(pool, {
    workspaceId: WS,
    name: 'r',
    type: 'failure_rate',
    params: { windowMinutes: 60, threshold: 0.5, minSample: 1 },
    ...(url ? { webhookUrl: url } : {}),
    ...(secret ? { webhookSecretEncrypted: encryptSecret(secret, alertKey) } : {}),
  });
  await withTx(pool, async (c) => {
    await fireAlert(c, { rule: { ...rule, webhookUrl: url }, detail: { type: 'failure_rate', observed: 0.9 }, firedAt: new Date() });
  });
  const ev = (await listAlertEvents(pool, WS, 1))[0]!;
  return { ruleId: rule.id, eventId: ev.id };
}

describe('runAlertDelivery', () => {
  test('POSTs a body signed with the rule secret', async () => {
    const secret = randomBytes(16).toString('hex');
    const ids = await seedFiring(`${baseUrl}/hook`, secret);
    await runAlertDelivery(deps, ids);
    expect(received).toHaveLength(1);
    const body = JSON.stringify(received[0]!.body);
    expect(received[0]!.sig).toBe('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
    expect((received[0]!.body as { ruleId: string }).ruleId).toBe(ids.ruleId);
  });

  test('throws on a non-2xx so BullMQ retries', async () => {
    respStatus = 500;
    const ids = await seedFiring(`${baseUrl}/hook`, randomBytes(8).toString('hex'));
    await expect(runAlertDelivery(deps, ids)).rejects.toThrow(/500/);
  });

  test('SSRF-blocks a private URL when private IPs are disallowed', async () => {
    const ids = await seedFiring('http://127.0.0.1:9/hook', randomBytes(8).toString('hex'));
    await expect(runAlertDelivery({ ...deps, allowPrivateIps: false }, ids)).rejects.toMatchObject({ code: 'ssrf_blocked' });
    expect(received).toHaveLength(0);
  });

  test('no-ops when the rule has no webhook', async () => {
    const ids = await seedFiring(null, null);
    await runAlertDelivery(deps, ids);
    expect(received).toHaveLength(0);
  });
});
