/**
 * Spawns the five backend services on the shared e2e ports (3100-3104) and a
 * Telegram stub on 3311. Mirrors e2e/test/helpers.ts in the root e2e package.
 */
import { exec, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from '../../../vitest.shared.js';

const execAsync = promisify(exec);

export const SERVICE_PORTS = [3100, 3101, 3102, 3103, 3104];
export const API_URL = 'http://127.0.0.1:3100';
export const GATEWAY_URL = 'http://127.0.0.1:3103';
export const TELEGRAM_STUB_PORT = 3311;
export const OPENROUTER_STUB_PORT = 3312;

const SERVICE_ENV = {
  ...process.env,
  // The same isolated stack the vitest suites use. Playwright is not vitest, so the
  // `test.env` in vitest.shared.ts does not reach here — without these two lines this
  // suite would spawn five services against whatever database `pnpm dev` is using, and
  // its worker would compete with the running one for the same queues.
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  API_PORT: '3100',
  ORCH_PORT: '3101',
  WORKER_PORT: '3102',
  GATEWAY_PORT: '3103',
  SCHEDULER_PORT: '3104',
  SCHEDULER_INTERVAL_MS: '500',
  GATEWAY_URL,
  TRIGGER_SECRET_KEY: 'xperiment-e2e-trigger-secret',
  CREDENTIALS_SECRET_KEY: 'xperiment-e2e-credentials-secret',
  HTTP_ALLOW_PRIVATE_IPS: 'true',
  OPENROUTER_API_KEY: 'sk-or-e2e-fake',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${OPENROUTER_STUB_PORT}`,
  OPENROUTER_MODEL: 'google/gemini-3.1-flash-lite',
  LOG_LEVEL: 'warn',
};

/** Canned workflow the OpenRouter stub returns — a webhook trigger → transform. */

const SERVICES = ['@xperiment/api', '@xperiment/orchestrator', '@xperiment/worker', '@xperiment/gateway', '@xperiment/scheduler'] as const;

export async function killPortOwners(
  ports: number[] = [...SERVICE_PORTS, TELEGRAM_STUB_PORT, OPENROUTER_STUB_PORT],
): Promise<void> {
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

async function waitForHealthz(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Service at ${url} did not become healthy`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startTelegramStub(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'xperiment_stub_bot' } }));
    });
  });
  return new Promise((resolve) => server.listen(TELEGRAM_STUB_PORT, '127.0.0.1', () => resolve(server)));
}

/** Marker in a prompt that makes the stub decline, exercising the error path. */
export const AI_FAIL_MARKER = 'TRIGGER_AI_FAILURE';
/** Holds the socket open, exercising the keep-alive and the Stop button. */
export const AI_STALL_MARKER = 'TRIGGER_AI_STALL';

const REMINDER_IR = {
  schemaVersion: '0.1',
  workflow: { id: 'wf_reminder', name: 'Pengingat makan' },
  entrypoints: ['at_noon'],
  nodes: [
    {
      id: 'at_noon',
      kind: 'trigger',
      type: 'schedule.trigger',
      operationVersion: '0.1.0',
      parameters: { cron: '0 12 * * *', timezone: 'Asia/Jakarta' },
    },
    {
      id: 'notify',
      kind: 'action',
      type: 'telegram.sendMessage',
      operationVersion: '0.1.0',
      parameters: { chatId: '123', text: 'Waktunya makan siang.' },
    },
  ],
  edges: [{ id: 'e1', from: { nodeId: 'at_noon', port: 'main' }, to: { nodeId: 'notify', port: 'input' } }],
  metadata: { layout: { at_noon: { x: 80, y: 120 }, notify: { x: 440, y: 120 } } },
};

const USAGE = { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 };

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  const body = {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'stub',
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: USAGE,
  };
  return ['data: ', JSON.stringify(body), '\n\n'].join('');
}

function sayText(content: string): string {
  const half = Math.ceil(content.length / 2);
  return (
    chunk({ role: 'assistant', content: content.slice(0, half) }) +
    chunk({ content: content.slice(half) }) +
    chunk({}, 'stop') +
    'data: [DONE]\n\n'
  );
}

function callTool(name: string, args: unknown): string {
  return (
    chunk({
      role: 'assistant',
      tool_calls: [{ index: 0, id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    }) +
    chunk({}, 'tool_calls') +
    'data: [DONE]\n\n'
  );
}

/**
 * A scripted, tool-calling, streaming OpenAI-compatible stub.
 *
 * The step is derived from how many tool results the incoming message list already
 * carries, NOT from a counter on the server. A counter leaks between tests in a serial
 * suite and produces the worst kind of flake.
 */
function scriptFor(messages: { role: string; content?: unknown }[], workflowId: string | null): string {
  const done = messages.filter((m) => m.role === 'tool').length;
  switch (done) {
    case 0:
      // A real model reads the id out of its instructions, which say which workflow is
      // open. Creating another one would build a second workflow beside it.
      return workflowId
        ? callTool('put_draft', { workflowId, definition: JSON.stringify(REMINDER_IR) })
        : callTool('create_workflow', { name: 'Pengingat makan' });
    case 1:
      return callTool('request_credential', {
        connectorKey: 'telegram',
        reason: 'to send the reminder',
        nodeId: 'notify',
      });
    default:
      return sayText('Sudah saya buatkan. Hubungkan Telegram, lalu tinjau dan tekan Publish.');
  }
}

/**
 * The workflow in play: the one named in the system instructions when the conversation
 * was opened from an editor, else the one a create_workflow result handed back.
 */
function targetWorkflowId(raw: string): string | null {
  const all = raw;
  const attached = /already attached to workflow ([0-9a-f-]{36})/.exec(all);
  if (attached) return attached[1] ?? null;
  const created = /\?"workflowId\?"\s*:\s*\?"([0-9a-f-]{36})/.exec(all);
  return created?.[1] ?? null;
}

function startOpenRouterStub(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages?: { role: string; content?: unknown }[] };
      const messages = body.messages ?? [];
      const asText = JSON.stringify(messages);
      res.setHeader('content-type', 'text/event-stream');
      if (asText.includes(AI_STALL_MARKER)) return; // hold the socket, never answer
      if (asText.includes(AI_FAIL_MARKER)) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'declined' } }));
        return;
      }
      // A beat before answering, so a chip's running state is observable rather than a
      // coin flip in the browser.
      setTimeout(() => res.end(scriptFor(messages, targetWorkflowId(raw))), 250);
    });
  });
  return new Promise((resolve) => server.listen(OPENROUTER_STUB_PORT, '127.0.0.1', () => resolve(server)));
}

export interface RunningStack {
  stop: () => Promise<void>;
}

export async function startStack(): Promise<RunningStack> {
  await killPortOwners();
  await execAsync('pnpm -w run migrate', { cwd: `${__dirname}/../../..` });
  const stub = await startTelegramStub();
  const aiStub = await startOpenRouterStub();
  const procs: ChildProcess[] = SERVICES.map((filter) =>
    spawn('pnpm', ['--filter', filter, 'start'], {
      env: SERVICE_ENV,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    }),
  );
  await waitForHealthz(`${API_URL}/v1/healthz`);
  await waitForHealthz(`${GATEWAY_URL}/healthz`);
  return {
    stop: async () => {
      for (const proc of procs) {
        if (proc.pid !== undefined && process.platform === 'win32') {
          await execAsync(`taskkill /pid ${proc.pid} /T /F`).catch(() => {});
        } else {
          proc.kill('SIGKILL');
        }
      }
      await new Promise<void>((r) => stub.close(() => r()));
      await new Promise<void>((r) => aiStub.close(() => r()));
      await killPortOwners();
    },
  };
}
