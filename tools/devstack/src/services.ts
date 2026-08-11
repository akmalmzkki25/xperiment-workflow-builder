/**
 * The stack `pnpm dev` starts, as data.
 *
 * Ports are duplicated from each service's own default rather than imported, because
 * importing them would mean loading five apps to print a table. The tests below are the
 * tripwire that keeps the duplicate honest.
 */

export interface ServiceDef {
  /** Shown in the log prefix. */
  name: string;
  /** pnpm workspace filter. */
  filter: string;
  /** Environment variable that overrides the port. */
  portEnv: string;
  defaultPort: number;
  /** Path that answers 200 once the service is serving. */
  healthPath: string;
  /** Arguments after `pnpm --filter <filter>`. `{port}` is substituted at spawn. */
  args: readonly string[];
}

/** The five backend services read their port from the environment, so `dev` suffices. */
const DEV: readonly string[] = ['dev'];

export const SERVICES: readonly ServiceDef[] = [
  { name: 'api', filter: '@xperiment/api', portEnv: 'API_PORT', defaultPort: 3000, healthPath: '/v1/healthz', args: DEV },
  { name: 'orchestrator', filter: '@xperiment/orchestrator', portEnv: 'ORCH_PORT', defaultPort: 3001, healthPath: '/healthz', args: DEV },
  { name: 'worker', filter: '@xperiment/worker', portEnv: 'WORKER_PORT', defaultPort: 3002, healthPath: '/healthz', args: DEV },
  { name: 'gateway', filter: '@xperiment/gateway', portEnv: 'GATEWAY_PORT', defaultPort: 3003, healthPath: '/healthz', args: DEV },
  { name: 'scheduler', filter: '@xperiment/scheduler', portEnv: 'SCHEDULER_PORT', defaultPort: 3004, healthPath: '/healthz', args: DEV },
  {
    name: 'web',
    filter: '@xperiment/web',
    portEnv: 'WEB_PORT',
    defaultPort: 3005,
    healthPath: '/',
    // The one service that cannot take its port from the environment: `apps/web` hardcodes
    // `next dev -p 3005`, and Next's `-p` beats every variable including `PORT`. Setting
    // WEB_PORT and calling `dev` would silently do nothing. The script is left alone
    // because Playwright's webServer runs `pnpm dev` and expects 3005.
    args: ['exec', 'next', 'dev', '-p', '{port}'],
  },
];

/**
 * Ports the e2e suites claim as their own.
 *
 * `killPortOwners` in both e2e helpers scrapes `netstat` and runs `taskkill /F` on
 * whatever listens here, at the start AND the end of every run. A dev stack that shared
 * one of these would be killed mid-session by a test run in another terminal, with no
 * error that points at the cause.
 */
export const E2E_RESERVED_PORTS: readonly number[] = [3100, 3101, 3102, 3103, 3104, 3311, 3312];

/** The full argument vector for `pnpm`, with `{port}` resolved. */
export function spawnArgs(service: ServiceDef, port: number): string[] {
  return ['--filter', service.filter, ...service.args.map((a) => a.replace('{port}', String(port)))];
}

export function portOf(service: ServiceDef, env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[service.portEnv];
  if (raw === undefined || raw.trim() === '') return service.defaultPort;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : service.defaultPort;
}

/** Every service's resolved port, in declaration order. */
export function resolvePorts(env: Readonly<Record<string, string | undefined>>): { service: ServiceDef; port: number }[] {
  return SERVICES.map((service) => ({ service, port: portOf(service, env) }));
}

/**
 * Ports two services would fight over.
 *
 * Reported up front rather than discovered as one service dying with EADDRINUSE while
 * the other four keep running and the stack looks half alive.
 */
export function portConflicts(env: Readonly<Record<string, string | undefined>>): string[] {
  const seen = new Map<number, string>();
  const conflicts: string[] = [];
  for (const { service, port } of resolvePorts(env)) {
    const owner = seen.get(port);
    if (owner !== undefined) conflicts.push(`${service.name} and ${owner} both want port ${port}`);
    else seen.set(port, service.name);
    if (E2E_RESERVED_PORTS.includes(port)) {
      conflicts.push(`${service.name} wants port ${port}, which the e2e suite force-kills on every run`);
    }
  }
  return conflicts;
}
