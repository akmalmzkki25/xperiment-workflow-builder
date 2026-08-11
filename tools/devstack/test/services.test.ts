import { describe, expect, test } from 'vitest';
import { E2E_RESERVED_PORTS, portConflicts, portOf, resolvePorts, SERVICES, spawnArgs } from '../src/services.js';

describe('the service table', () => {
  test('starts everything a working stack needs', () => {
    expect(SERVICES.map((s) => s.name)).toEqual([
      'api',
      'orchestrator',
      'worker',
      'gateway',
      'scheduler',
      'web',
    ]);
  });

  test('no two services share a default port', () => {
    const ports = SERVICES.map((s) => s.defaultPort);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test('names, filters and port variables are all distinct', () => {
    for (const key of ['name', 'filter', 'portEnv'] as const) {
      const values = SERVICES.map((s) => s[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  test('the defaults match what each service reads when nothing is set', () => {
    // Duplicated from the apps on purpose — importing five services to print a table is
    // absurd. This is the tripwire that keeps the duplicate honest.
    const byName = Object.fromEntries(SERVICES.map((s) => [s.name, s]));
    expect(byName['api']!.defaultPort).toBe(3000);
    expect(byName['orchestrator']!.defaultPort).toBe(3001);
    expect(byName['worker']!.defaultPort).toBe(3002);
    expect(byName['gateway']!.defaultPort).toBe(3003);
    expect(byName['scheduler']!.defaultPort).toBe(3004);
    expect(byName['web']!.defaultPort).toBe(3005);
  });

  test('nothing sits on a port the e2e suite force-kills', () => {
    // Both e2e helpers scrape netstat and taskkill whatever owns 3100-3104 and 3311-3312,
    // at the start AND the end of every run. A dev stack sharing one would die mid-session
    // with nothing in the output pointing at the cause.
    for (const service of SERVICES) {
      expect(E2E_RESERVED_PORTS, service.name).not.toContain(service.defaultPort);
    }
  });
});

describe('spawnArgs', () => {
  test('the backend services just run their dev script', () => {
    expect(spawnArgs(SERVICES[0]!, 3000)).toEqual(['--filter', '@xperiment/api', 'dev']);
  });

  test("web gets its port as a flag, because Next's -p beats every variable", () => {
    // apps/web hardcodes `next dev -p 3005`. Setting WEB_PORT and calling `dev` would
    // silently do nothing, so a reported conflict would be unresolvable.
    const web = SERVICES.find((s) => s.name === 'web')!;
    expect(spawnArgs(web, 4005)).toEqual(['--filter', '@xperiment/web', 'exec', 'next', 'dev', '-p', '4005']);
  });

  test('every service can express its port one way or the other', () => {
    for (const service of SERVICES) {
      const args = spawnArgs(service, 4321).join(' ');
      const viaFlag = args.includes('4321');
      const viaEnv = service.args === undefined || !service.args.some((a) => a.includes('{port}'));
      expect(viaFlag || viaEnv, service.name).toBe(true);
    }
  });

  test('leaves the definition untouched, so a second spawn is not corrupted', () => {
    const web = SERVICES.find((s) => s.name === 'web')!;
    spawnArgs(web, 1234);
    expect(spawnArgs(web, 4005)).toContain('4005');
  });
});

describe('portOf', () => {
  test('an override is honoured', () => {
    expect(portOf(SERVICES[0]!, { API_PORT: '4000' })).toBe(4000);
  });

  test('an unset or blank variable falls back to the default', () => {
    expect(portOf(SERVICES[0]!, {})).toBe(3000);
    expect(portOf(SERVICES[0]!, { API_PORT: '   ' })).toBe(3000);
  });

  test('nonsense falls back rather than binding port zero or NaN', () => {
    for (const bad of ['abc', '0', '-1', '70000', '3000.5']) {
      expect(portOf(SERVICES[0]!, { API_PORT: bad }), bad).toBe(3000);
    }
  });
});

describe('portConflicts', () => {
  test('a clean environment has none', () => {
    expect(portConflicts({})).toEqual([]);
  });

  test('two services pointed at one port is reported before anything starts', () => {
    // Otherwise one service dies with EADDRINUSE while the other four keep running and
    // the stack looks half alive.
    const conflicts = portConflicts({ WORKER_PORT: '3000' });
    expect(conflicts.some((c) => c.includes('3000'))).toBe(true);
  });

  test('an override onto an e2e port is refused', () => {
    expect(portConflicts({ API_PORT: '3100' }).some((c) => c.includes('force-kills'))).toBe(true);
  });

  test('resolvePorts keeps declaration order', () => {
    expect(resolvePorts({}).map((r) => r.service.name)).toEqual(SERVICES.map((s) => s.name));
  });
});
