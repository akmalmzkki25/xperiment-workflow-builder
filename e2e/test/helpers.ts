import { exec, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { createPool, runMigrations } from '@xperiment/db';
import type { Pool } from 'pg';

const execAsync = promisify(exec);

export const SERVICE_PORTS = [3100, 3101, 3102, 3103, 3104];

export const API_URL = 'http://127.0.0.1:3100';

const SERVICE_ENV = {
  ...process.env,
  API_PORT: '3100',
  ORCH_PORT: '3101',
  WORKER_PORT: '3102',
  GATEWAY_PORT: '3103',
  SCHEDULER_PORT: '3104',
  SCHEDULER_INTERVAL_MS: '500',
  GATEWAY_URL: 'http://127.0.0.1:3103',
  TRIGGER_SECRET_KEY: 'xperiment-e2e-trigger-secret',
  CREDENTIALS_SECRET_KEY: 'xperiment-e2e-credentials-secret',
  HTTP_ALLOW_PRIVATE_IPS: 'true',
  WORKER_LOCK_DURATION: '2000',
  WORKER_STALLED_INTERVAL: '500',
  LOG_LEVEL: 'warn',
};

export function spawnService(
  filter: '@xperiment/api' | '@xperiment/orchestrator' | '@xperiment/worker' | '@xperiment/gateway' | '@xperiment/scheduler',
): ChildProcess {
  return spawn('pnpm', ['--filter', filter, 'start'], {
    env: SERVICE_ENV,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
}

export function killService(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: true });
  } else {
    proc.kill('SIGKILL');
  }
}

/**
 * Kill whatever still listens on the dedicated e2e service ports. On Windows the
 * pnpm shim nesting can survive a tree-kill of the wrapper pid, so cleanup kills
 * by port as a backstop. Safe: 3100-3102 exist only for this suite.
 */
export async function killPortOwners(ports: number[] = SERVICE_PORTS): Promise<void> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync('netstat -ano -p tcp').catch(() => ({ stdout: '' }));
    const pids = new Set<string>();
    for (const line of stdout.split('\n')) {
      const m = /TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && ports.includes(Number(m[1]))) pids.add(m[2]!);
    }
    for (const pid of pids) {
      await execAsync(`taskkill /pid ${pid} /T /F`).catch(() => {});
    }
  } else {
    for (const port of ports) {
      await execAsync(`lsof -ti tcp:${port} | xargs -r kill -9`).catch(() => {});
    }
  }
}

/** Wait until nothing answers on the service ports (previous test file's processes fully dead). */
export async function waitForPortsFree(timeoutMs = 20000): Promise<void> {
  const urls = [
    `${API_URL}/v1/healthz`,
    'http://127.0.0.1:3101',
    'http://127.0.0.1:3102',
    'http://127.0.0.1:3103/healthz',
    'http://127.0.0.1:3104',
  ];
  const deadline = Date.now() + timeoutMs;
  let killedOnce = false;
  for (;;) {
    let anyAlive = false;
    for (const url of urls) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(500) });
        anyAlive = true;
      } catch {
        /* port free */
      }
    }
    if (!anyAlive) return;
    if (!killedOnce) {
      killedOnce = true;
      await killPortOwners();
    }
    if (Date.now() > deadline) throw new Error('Service ports still occupied by a previous run');
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function waitForHealthz(url: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`Service at ${url} did not become healthy`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function prepareDatabase(): Promise<Pool> {
  const pool = createPool();
  await runMigrations(pool);
  await pool.query(
    `TRUNCATE executions, execution_nodes, execution_events, trigger_events, task_outbox, workflow_versions, workflow_drafts, workflows CASCADE`,
  );
  return pool;
}

export interface StubServer {
  url: string;
  received: { path: string; body: unknown }[];
  setResponses(path: string, statuses: number[]): void;
  close(): Promise<void>;
}

export async function startStubServer(): Promise<StubServer> {
  const scripted = new Map<string, number[]>();
  const received: { path: string; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const path = new URL(req.url!, 'http://localhost').pathname;
      received.push({ path, body: raw.length > 0 ? JSON.parse(raw) : null });
      if (path === '/slow') {
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        }, 4000);
        return;
      }
      const queue = scripted.get(path);
      const status = queue && queue.length > 0 ? queue.shift()! : 200;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`,
    received,
    setResponses: (path, statuses) => scripted.set(path, [...statuses]),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let cachedToken: string | null = null;

/** Registers (or logs in) the shared e2e user against the live API; cached per test file. */
export async function ensureAuth(): Promise<string> {
  if (cachedToken) return cachedToken;
  const credentials = { email: 'e2e@xperiment.test', password: 'password-e2e-123' };
  const reg = await fetch(`${API_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (reg.status === 201) {
    cachedToken = ((await reg.json()) as { token: string }).token;
    return cachedToken;
  }
  const login = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!login.ok) throw new Error(`e2e auth failed: ${login.status}`);
  cachedToken = ((await login.json()) as { token: string }).token;
  return cachedToken;
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: T }> {
  const token = path.startsWith('/v1/auth/') ? null : await ensureAuth();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : null) as T };
}

export async function createPublishedWorkflow(definition: unknown): Promise<string> {
  const created = await api<{ id: string }>('POST', '/v1/workflows', { name: 'e2e' });
  await api('PUT', `/v1/workflows/${created.body.id}/draft`, { definition }, { 'if-match': '1' });
  const published = await api<{ versionNumber: number }>('POST', `/v1/workflows/${created.body.id}/publish`);
  if (published.status !== 201) throw new Error(`Publish failed: ${JSON.stringify(published.body)}`);
  return created.body.id;
}

export interface ExecutionDetail {
  execution: { status: string };
  nodes: { nodeId: string; status: string; attempt: number }[];
  events: { eventType: string }[];
}

export async function waitForTerminal(executionId: string, timeoutMs = 30000): Promise<ExecutionDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api<ExecutionDetail>('GET', `/v1/executions/${executionId}`);
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(body.execution.status)) return body;
    if (Date.now() > deadline) throw new Error(`Execution ${executionId} did not finish: ${body.execution.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function leadCheckIr(stubUrl: string): unknown {
  return {
    schemaVersion: '0.1',
    workflow: { id: 'wf_lead', name: 'Lead check' },
    entrypoints: ['t'],
    nodes: [
      { id: 't', kind: 'trigger', type: 'manual.trigger', operationVersion: '0.1.0', parameters: {} },
      {
        id: 'branch',
        kind: 'logic',
        type: 'core.if',
        operationVersion: '0.1.0',
        parameters: { condition: '{{ trigger.body.total > 100 }}' },
      },
      {
        id: 'notify',
        kind: 'action',
        type: 'http.request',
        operationVersion: '0.1.0',
        parameters: { method: 'POST', url: `${stubUrl}/notify`, body: { name: '{{ trigger.body.name }}' } },
        settings: { timeoutMs: 5000, retry: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 400 } },
      },
      {
        id: 'archive',
        kind: 'logic',
        type: 'core.transform',
        operationVersion: '0.1.0',
        parameters: { fields: { archived: true, name: '{{ trigger.body.name }}' } },
      },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 't', port: 'main' }, to: { nodeId: 'branch', port: 'input' } },
      { id: 'e2', from: { nodeId: 'branch', port: 'true' }, to: { nodeId: 'notify', port: 'input' } },
      { id: 'e3', from: { nodeId: 'branch', port: 'false' }, to: { nodeId: 'archive', port: 'input' } },
    ],
  };
}
