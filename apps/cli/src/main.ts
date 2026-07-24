import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
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

await program.parseAsync(process.argv);
