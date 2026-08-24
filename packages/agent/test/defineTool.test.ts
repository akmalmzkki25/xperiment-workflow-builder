import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { freshRunState, guard, MAX_WRITES_PER_TURN, type AgentRunContext, type XperimentToolSpec } from '../src/defineTool.js';
import { AGENT_TOOL_IDS, AGENT_TOOL_PERMISSIONS, type RequiredPermission } from '../src/permissions.js';

function ctx(granted: RequiredPermission[]): AgentRunContext {
  return {
    // The tools under test here never touch either, and the guard runs before `run` does.
    pool: null as never,
    registry: null as never,
    workspaceId: 'ws-1',
    userId: 'u-1',
    grantedPermissions: new Set(granted),
    runState: freshRunState(),
  };
}

let ran = 0;
const reader: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  id: 'list_workflows',
  description: 'read something',
  permission: 'workflow:read',
  mutates: false,
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ ok: z.boolean() }),
  run: async () => {
    ran += 1;
    return { ok: true };
  },
};

const writer: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
  ...reader,
  id: 'put_draft',
  permission: 'workflow:write',
  mutates: true,
};

describe('guard', () => {
  test('a missing permission returns an error rather than throwing', async () => {
    // Returned, not thrown, on purpose: a thrown tool kills the turn, while a typed error
    // lets the model say "ask a workspace admin", which is the answer the person needs.
    const before = ran;
    const out = await guard(reader, {}, ctx([]));
    expect(out).toMatchObject({ error: 'forbidden', permission: 'workflow:read' });
    expect(ran, 'run must not have been invoked').toBe(before);
  });

  test('the granted permission lets the tool run', async () => {
    const out = await guard(reader, {}, ctx(['workflow:read']));
    expect(out).toEqual({ ok: true });
  });

  test('a write budget bounds how much one turn can change', async () => {
    const c = ctx(['workflow:write']);
    for (let i = 0; i < MAX_WRITES_PER_TURN; i += 1) {
      expect(await guard(writer, {}, c)).toEqual({ ok: true });
    }
    expect(await guard(writer, {}, c)).toMatchObject({ error: 'write_budget_exhausted' });
  });

  test('reads are not charged against the write budget', async () => {
    const c = ctx(['workflow:read', 'workflow:write']);
    for (let i = 0; i < MAX_WRITES_PER_TURN + 3; i += 1) await guard(reader, {}, c);
    expect(await guard(writer, {}, c)).toEqual({ ok: true });
  });

  test('every call is recorded, so the transcript can show what the agent did', async () => {
    const c = ctx(['workflow:read']);
    await guard(reader, {}, c);
    expect(c.runState.toolCalls).toHaveLength(1);
    expect(c.runState.toolCalls[0]).toMatchObject({ tool: 'list_workflows', ok: true });
  });

  test('a tool that throws becomes a recorded failure, not a dead turn', async () => {
    const boom: XperimentToolSpec<z.ZodTypeAny, z.ZodTypeAny> = {
      ...reader,
      run: async () => {
        throw new Error('provider exploded');
      },
    };
    const c = ctx(['workflow:read']);
    const out = await guard(boom, {}, c);
    expect(out).toMatchObject({ error: 'tool_failed' });
    // The message must not carry the raw throw: a tool talks to Postgres and to
    // providers, and their error text has a habit of quoting what was sent.
    expect(JSON.stringify(out)).not.toContain('provider exploded');
    expect(c.runState.toolCalls[0]).toMatchObject({ ok: false });
  });

  test('a recorded call never carries a secret-shaped argument value', async () => {
    const c = ctx(['workflow:read']);
    await guard(reader, { botToken: '123456789:AAExampleExampleExampleExample', nodeId: 'notify' }, c);
    const recorded = JSON.stringify(c.runState.toolCalls[0]);
    expect(recorded).not.toContain('AAExample');
    expect(recorded).toContain('notify');
  });
});

describe('AGENT_TOOL_PERMISSIONS', () => {
  test('every declared tool id has a permission', () => {
    // The Record is exhaustive over AgentToolId, so this is the runtime echo of a
    // compile-time guarantee — and it fails loudly if the union is widened by hand.
    expect(Object.keys(AGENT_TOOL_PERMISSIONS).sort()).toEqual([...AGENT_TOOL_IDS].sort());
  });

  test('no tool asks for a permission outside the four the agent may hold', () => {
    const allowed = new Set(['workflow:read', 'workflow:write', 'connection:read', 'connection:write']);
    for (const [id, perm] of Object.entries(AGENT_TOOL_PERMISSIONS)) {
      expect(allowed.has(perm), `${id} -> ${perm}`).toBe(true);
    }
  });

  test('there is no tool that could publish, activate, execute or delete', () => {
    // Not merely unimplemented. The instructions tell the model these do not exist, and
    // this is what stops one arriving later without the decision being made again.
    for (const id of AGENT_TOOL_IDS) {
      expect(id).not.toMatch(/publish|activate|execute|delete|rotate/);
    }
  });
});
