import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { normalizeArgv } from './argv.js';
import { clearToken, loadToken, saveToken } from './auth.js';
import { ApiClient, ApiError } from './client.js';
import { renderTimeline } from './render.js';

const TERMINAL = ['SUCCEEDED', 'FAILED', 'TIMED_OUT'];
const client = new ApiClient(undefined, loadToken());
const program = new Command().name('xperiment').description('Xperiment workflow CLI');

function fail(e: unknown): never {
  if (e instanceof ApiError) {
    console.error(`Error ${e.status}:`, JSON.stringify(e.problem, null, 2));
  } else {
    console.error((e as Error).message);
  }
  process.exit(1);
}

program
  .command('login')
  .requiredOption('--email <email>')
  .requiredOption('--password <password>')
  .action(async (opts: { email: string; password: string }) => {
    try {
      const { token } = await client.login(opts.email, opts.password);
      saveToken(token);
      client.setToken(token);
      console.log('Logged in.');
    } catch (e) {
      fail(e);
    }
  });

program.command('logout').action(() => {
  clearToken();
  console.log('Logged out.');
});

const workflow = program.command('workflow');

workflow
  .command('create')
  .requiredOption('--name <name>')
  .option('--definition <file>', 'JSON file with the draft IR')
  .action(async (opts: { name: string; definition?: string }) => {
    try {
      const wf = await client.createWorkflow(opts.name);
      if (opts.definition) {
        const definition: unknown = JSON.parse(await readFile(opts.definition, 'utf8'));
        await client.updateDraft(wf.id, definition, wf.draftRevision);
      }
      console.log(JSON.stringify(wf, null, 2));
    } catch (e) {
      fail(e);
    }
  });

workflow.command('list').action(async () => {
  try {
    const { items } = await client.listWorkflows();
    for (const wf of items) console.log(`${wf.id}  ${wf.status.padEnd(10)} ${wf.name}`);
  } catch (e) {
    fail(e);
  }
});

workflow.command('get <id>').action(async (id: string) => {
  try {
    console.log(JSON.stringify(await client.getWorkflow(id), null, 2));
  } catch (e) {
    fail(e);
  }
});

workflow.command('validate <id>').action(async (id: string) => {
  try {
    const result = await client.validate(id);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exit(2);
  } catch (e) {
    fail(e);
  }
});

workflow.command('publish <id>').action(async (id: string) => {
  try {
    console.log(JSON.stringify(await client.publish(id), null, 2));
  } catch (e) {
    fail(e);
  }
});

program
  .command('run <workflowId>')
  .requiredOption('--input <file>', 'JSON file with the trigger payload')
  .option('--watch', 'poll until the execution reaches a terminal state')
  .option('--idempotency-key <key>')
  .action(async (workflowId: string, opts: { input: string; watch?: boolean; idempotencyKey?: string }) => {
    try {
      const payload: unknown = JSON.parse(await readFile(opts.input, 'utf8'));
      const exec = await client.execute(workflowId, payload, opts.idempotencyKey);
      console.log(`Execution ${exec.executionId} (${exec.created ? 'created' : 'duplicate'})`);
      if (!opts.watch) return;
      for (;;) {
        const detail = await client.getExecution(exec.executionId);
        console.log('\n' + renderTimeline(detail));
        if (TERMINAL.includes(detail.execution.status)) {
          if (detail.execution.status !== 'SUCCEEDED') process.exit(2);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('execution')
  .command('get <id>')
  .action(async (id: string) => {
    try {
      const detail = await client.getExecution(id);
      console.log(renderTimeline(detail));
      console.log('\nEvents:');
      for (const ev of detail.events) console.log(`  ${ev.sequence}  ${ev.eventType}  ${ev.nodeId ?? ''}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('prune')
  .description('Delete run history, webhook bodies and settled bookkeeping past their retention')
  .option('--execution-days <n>', 'keep executions this long', '30')
  .option('--trigger-days <n>', 'keep recorded webhook bodies this long', '30')
  .option('--batch <n>', 'rows per table per run', '5000')
  .option('--dry-run', 'report what the clamped policy would be and delete nothing')
  .action(async (opts: { executionDays: string; triggerDays: string; batch: string; dryRun?: boolean }) => {
    const { appendAuditEvent, clampPolicy, createPool, pruneExpired } = await import('@xperiment/db');
    const requested = {
      executionDays: Number(opts.executionDays),
      triggerEventDays: Number(opts.triggerDays),
    };
    const policy = clampPolicy(requested);
    // Printed always: audit and usage have floors the flags cannot go under, and an
    // operator who asked for thirty days of audit deserves to be told they got ninety.
    console.log(`policy ${JSON.stringify(policy)}`);
    if (opts.dryRun) return;

    const pool = createPool();
    try {
      const result = await pruneExpired(pool, requested, Number(opts.batch));
      for (const [table, deleted] of Object.entries(result)) {
        console.log(`${table.padEnd(16)} deleted=${deleted}`);
      }
      // One row per run. workspaceId is null because a sweep spans every workspace,
      // and global rows never surface in a single workspace's audit view.
      await appendAuditEvent(pool, {
        actorKind: 'system',
        action: 'retention.prune',
        metadata: { ...result, ...policy },
      });
      const total = Object.values(result).reduce((a, b) => a + b, 0);
      // A full batch means there is more to do; exit 2 so a cron can loop rather than
      // silently leaving half the backlog behind.
      if (total >= Number(opts.batch)) {
        console.error('batch was full — more rows remain, re-run to continue');
        process.exit(2);
      }
    } catch (e) {
      fail(e);
    } finally {
      await pool.end();
    }
  });

program
  .command('rekey')
  .description('Re-encrypt legacy secrets under per-workspace envelope encryption')
  .option('--batch-size <n>', 'rows per query', '100')
  .action(async (opts: { batchSize: string }) => {
    // Imported dynamically so no other CLI command pays for a database connection.
    const {
      appendAuditEvent,
      createKeyProviderFromEnv,
      createPool,
      createSecretVault,
      createWorkspaceKeyring,
      deriveLegacyKey,
      rekeyAll,
    } = await import('@xperiment/db');
    const pool = createPool();
    try {
      const keyring = createWorkspaceKeyring({ pool, provider: await createKeyProviderFromEnv() });
      const progress = await rekeyAll({
        pool,
        credentialsVault: createSecretVault({
          keyring,
          legacyKey: deriveLegacyKey(process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me'),
        }),
        triggerVault: createSecretVault({
          keyring,
          legacyKey: deriveLegacyKey(process.env['TRIGGER_SECRET_KEY'] ?? 'xperiment-dev-trigger-secret-change-me'),
        }),
        batchSize: Number(opts.batchSize),
      });
      for (const p of progress) console.log(`${p.table.padEnd(20)} rekeyed=${p.rekeyed}  remaining=${p.remaining}`);
      // One event per run, not per row: a backfill is bulk mechanical work and per-row
      // rows would flood the table. workspaceId is null because a run spans every
      // workspace, and global rows never surface in a workspace's audit view.
      await appendAuditEvent(pool, {
        actorKind: 'system',
        action: 'secret.rekey_batch',
        metadata: Object.fromEntries(progress.map((p) => [p.table, p.rekeyed])),
      });
      const left = progress.reduce((sum, p) => sum + p.remaining, 0);
      if (left > 0) {
        console.error(`${left} row(s) still at enc_version 0 — keep the legacy keys configured and re-run.`);
        process.exit(2);
      }
    } catch (e) {
      fail(e);
    } finally {
      await pool.end();
    }
  });

program
  .command('seed')
  .description('Fill a LOCAL development database with a demo workspace, workflows and run history')
  .option('--name <name>', 'workspace name', 'Toko Demo (FAKE)')
  .option('--runs <n>', 'how many executions of history to fabricate', '240')
  .option('--days <n>', 'how far back the history reaches', '30')
  .option('--seed <n>', 'PRNG seed, so the same demo can be reproduced', '1902558064')
  .option('--force', 'override the environment gates — type it deliberately')
  .action(async (opts: { name: string; runs: string; days: string; seed: string; force?: boolean }) => {
    // Imported dynamically so no other CLI command pays for a database connection.
    const {
      appendAuditEvent,
      assertSeedable,
      createKeyProviderFromEnv,
      createPool,
      createSecretVault,
      createWorkspaceKeyring,
      deriveLegacyKey,
      seedDemoWorkspace,
    } = await import('@xperiment/db');
    const { canonicalHash } = await import('@xperiment/ir');

    // Before the pool, not after: refusing should not need a database connection, and an
    // unreachable production host must fail on the gate rather than on the socket.
    try {
      assertSeedable(process.env, { force: opts.force === true });
    } catch (e) {
      fail(e);
    }

    const pool = createPool();
    try {
      const keyring = createWorkspaceKeyring({ pool, provider: await createKeyProviderFromEnv() });
      const summary = await seedDemoWorkspace(
        {
          pool,
          hashDefinition: (d) => canonicalHash(d as Parameters<typeof canonicalHash>[0]),
          vault: createSecretVault({
            keyring,
            legacyKey: deriveLegacyKey(
              process.env['CREDENTIALS_SECRET_KEY'] ?? 'xperiment-dev-credentials-secret-change-me',
            ),
          }),
        },
        {
          workspaceName: opts.name,
          runs: Number(opts.runs),
          days: Number(opts.days),
          seed: Number(opts.seed),
        },
      );
      console.log(`workspace  ${summary.workspaceId}  ${summary.workspaceName}`);
      console.log(`workflows  ${summary.workflows}`);
      console.log(`connections ${summary.connections} (fabricated — every host is .invalid)`);
      console.log(`executions ${summary.executions}`);
      console.log(`usage rows ${summary.usageEvents}`);
      await appendAuditEvent(pool, {
        workspaceId: summary.workspaceId,
        actorKind: 'system',
        action: 'workspace.create',
        metadata: { seeded: true, executions: summary.executions },
      });
    } catch (e) {
      fail(e);
    } finally {
      await pool.end();
    }
  });

await program.parseAsync(normalizeArgv(process.argv));
