/**
 * Spawns the five backend services on the shared e2e ports (3100-3104) and a
 * Telegram stub on 3311. Mirrors e2e/test/helpers.ts in the root e2e package.
 */
import { exec, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export const SERVICE_PORTS = [3100, 3101, 3102, 3103, 3104];
export const API_URL = 'http://127.0.0.1:3100';
export const GATEWAY_URL = 'http://127.0.0.1:3103';
export const TELEGRAM_STUB_PORT = 3311;

const SERVICE_ENV = {
  ...process.env,
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
  LOG_LEVEL: 'warn',
};

const SERVICES = ['@xperiment/api', '@xperiment/orchestrator', '@xperiment/worker', '@xperiment/gateway', '@xperiment/scheduler'] as const;

export async function killPortOwners(ports: number[] = [...SERVICE_PORTS, TELEGRAM_STUB_PORT]): Promise<void> {
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

export interface RunningStack {
  stop: () => Promise<void>;
}

export async function startStack(): Promise<RunningStack> {
  await killPortOwners();
  await execAsync('pnpm -w run migrate', { cwd: `${__dirname}/../../..` });
  const stub = await startTelegramStub();
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
      await killPortOwners();
    },
  };
}
