import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { spawnArgs, type ServiceDef } from './services.js';

/**
 * Starts the stack and, more importantly, stops it.
 *
 * Two Windows facts drive every decision here, both measured on the reference machine
 * rather than assumed:
 *
 * 1. `where pnpm` returns a POSIX shell script and a `.cmd` shim — there is no
 *    `pnpm.exe`. libuv's CreateProcess does not apply PATHEXT, so `spawn('pnpm', …)`
 *    without a shell emits `ENOENT` immediately. Hence `shell` on win32, which both
 *    existing e2e helpers already carry for the same reason.
 * 2. Because of that shell, the pid we hold is `cmd.exe`, which wraps `pnpm.cmd`, which
 *    spawns node. `proc.kill()` reaches the wrapper and leaves the grandchild holding
 *    the port. Hence `taskkill /T /F`.
 *
 * Ctrl-C does not propagate to those grandchildren either, so shutdown is explicit.
 */

const IS_WINDOWS = process.platform === 'win32';

export interface RunningService {
  service: ServiceDef;
  port: number;
  child: ChildProcess;
}

export function startService(
  service: ServiceDef,
  port: number,
  env: Readonly<Record<string, string>>,
): RunningService {
  const child = spawn('pnpm', spawnArgs(service, port), {
    env: { ...env, [service.portEnv]: String(port) },
    shell: IS_WINDOWS,
    stdio: 'inherit',
  });
  return { service, port, child };
}

/** Kill one child and everything it spawned. Never throws: shutdown must finish. */
export async function stopService(running: RunningService): Promise<void> {
  const pid = running.child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: true, stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  try {
    running.child.kill('SIGTERM');
  } catch {
    // Already gone. Nothing to do, and nothing worth saying.
  }
}

/** Whether something is still listening on a port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (inUse: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Ports still held after a shutdown.
 *
 * Reported, never swept. The e2e helpers can safely `taskkill` whatever owns 3100-3104
 * because those ports exist only for that suite; 3000 does not. Killing by port here
 * would eventually take out somebody's unrelated dev server, and a tool that does that
 * once is a tool nobody runs again.
 */
export async function stillHeld(ports: readonly number[]): Promise<number[]> {
  const checked = await Promise.all(ports.map(async (p) => ({ p, held: await portInUse(p) })));
  return checked.filter((c) => c.held).map((c) => c.p);
}
