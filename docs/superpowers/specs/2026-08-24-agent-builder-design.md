# Conversational workflow builder on Mastra — design

**Status:** approved, in delivery. Stages 0–3 complete; this records what the Stage 3
spike found, because two of the design's open questions were answered by measurement and
one of the answers is better than either option that had been planned for.

## The defect this exists to fix

Asked for a Telegram lunch reminder, the one-shot builder emitted a `core.transform` node
named `telegram_message_placeholder` — a workflow that fires on time and sends nothing.

Not a hallucination. `packages/ai/src/prompts.ts:70` put this in the system prompt whenever
the workspace had no connections:

```
None. Do not use any node that requiresConnection.
```

`telegram.sendMessage` declares `requiresConnection: 'telegram'`, so the model was
forbidden from using the only correct node and substituted a placeholder. Nothing told the
user why.

**The fix is to break the coupling, not to reword the sentence.** Which node is correct
follows from what the user asked for. Whether a credential exists is a separate fact that
changes the *report*, never the *graph*. Measured against the real registry, a
`telegram.sendMessage` node with no `connectionRef` produces exactly one finding —
`connection_required` on that node — which is the right node, in the right place, with a
named problem attached.

## Spike findings (Stage 3)

### 1. There is no custom-`fetch` seam on the model config, and it does not matter

`new Agent({ model: { id, url, apiKey, fetch } })` — the `fetch` is ignored. Measured: the
wrapper was invoked 0 times while the request still reached the stub.

But the thing that seam was wanted for is available directly and better:

```
onStepFinish fires per step, carries usage, and fires on a run that then throws.
```

Measured against a stub that answers one tool-calling step (110 tokens) and then returns
500 on the second: `onStepFinish` fired twice, the first carrying
`{inputTokens:100, outputTokens:10, totalTokens:110}`. The thrown error carries **neither**
`steps` nor `usage`.

That kills the planned fallback outright — `finally` + sum `steps[].usage` would have
recorded zero for exactly the failure it existed to cover. **Metering accumulates in
`onStepFinish` into the closure-scoped `RunState`.** Every answered call is counted the
moment it is answered, and a throw cannot take it away.

Usage arrives in AI SDK v5 shape (`inputTokens`/`outputTokens`/`totalTokens`) with the raw
OpenRouter `prompt_tokens`/`completion_tokens` nested underneath, so `normalizeUsage` reads
the v5 spelling and needs no guessing.

### 2. The IR schema converts cleanly and is small, but one field stays open

`zodToJsonSchema(workflowIrSchema)` is **2,642 bytes** with zero `additionalProperties:
true`. Small enough to inline in the instructions as a machine-checked contract, which is
strictly better than the prose contract it replaces.

The one problem is structural and unavoidable:

```
node.parameters -> {"type":"object","additionalProperties":{}}
```

An open record, because a node's parameters differ per connector; closing it would mean
enumerating 29 connectors as a union. OpenAI-style strict tool schemas reject that.

**Decision: `put_draft` takes `definition` as a JSON string, parsed server-side with
`workflowIrSchema`.** Not because strict mode is certain to bite, but because
`OPENROUTER_MODEL` is user-configurable — the provider that will actually run this cannot
be tested from here, so the option that works on every provider wins. The guarantee is
identical (same schema, same errors, a clean `not_json` back to the model), and the 2.6 KB
schema still goes into the instructions as documentation.

### 3. Dependency due diligence

`@mastra/core@1.61.0` installs 133 packages. Two were called out as disqualifying in
review; both were checked against the actual dist rather than the manifest.

| Package | Finding |
|---|---|
| `posthog-node` | Only in `dist/telemetry/*`. **Not reachable** from `dist/agent/index.js` (96-module graph). |
| `@modelcontextprotocol/server` | Same — not in the agent graph. |
| `execa` | **Is** in the agent graph, via `workspace-ZZhrDe7P.js`. But behind `await import()` with a runtime-constructed specifier, deliberately so bundlers cannot resolve it, for the sandbox / local-process-manager feature. Never loaded unless that feature is used, and we never touch it. |

A real agent run against a local stub contacted **no off-box host**, with and without
`MASTRA_TELEMETRY_DISABLED=1` (checked by patching `net.Socket.prototype.connect`).

Residual risk, stated plainly and not resolved by any of the above: 133 packages are
*installed*, and install-time lifecycle scripts run regardless of what is later imported.
"Not loaded" is not "not present". `MASTRA_TELEMETRY_DISABLED=1` is set anyway, and the
version is pinned exactly rather than with a caret.

## Architecture

```
packages/agent/          @xperiment/agent — Mastra Agent, tools, instructions
apps/api/src/routes/agent.ts   HTTP + SSE, RBAC, quota, metering
apps/api/src/ai/chatTurn.ts    runChatTurn() — pure, no Fastify
packages/connectors/src/credentialGuides.ts   (shipped, stage 2)
packages/db/src/migrations/0023_agent_conversations.sql
apps/web/src/components/editor/AiChat.tsx     replaces AiDock.tsx
packages/ai/                                  deleted
```

`app.inject()` cannot test a hijacked reply, and every route test uses it. So the turn
logic lives in a pure function taking an `emit` callback, and the Fastify route is a thin
wire adapter — mirroring how `generateWorkflow` was testable with a fake client while
`routes/ai.ts` stayed thin.

### Two hard rules on tools

1. **No `workspaceId` in any input schema** — structurally absent, not validated away, so
   no token sequence the model can emit reaches it. Tools are built per request by a
   factory closing over `{ pool, registry, workspaceId, userId, grantedPermissions,
   runState }`. `RequestContext` carries identity; a closure-scoped `RunState` carries the
   mutable ledger, because a `RequestContext` mutation inside one tool does not propagate
   to the next.
2. **`permission` is a required field of the tool spec** — a tool that forgets it is one
   compile error in one place. The `ConnectorDisplay` precedent.

A missing permission **returns** `{ error: 'forbidden' }` rather than throwing, so the
model can say "ask a workspace admin" instead of the turn dying.

Deliberately absent, and named as absent in the instructions: `publish`, `activate`,
`create_connection`, `execute`, `delete_*`. A model told it cannot publish behaves far
better than one that finds no tool and improvises.

### Credentials never enter the transcript

`request_credential` is terminal: it creates nothing, it ends the turn, and the UI opens
the existing encrypted connection form. Its input schema has no field capable of holding a
secret, and a test asserts that.

Because `redactSecrets` matches key *names*, it cannot catch a raw token pasted as free
text. So the transcript writer also matches credential *shapes* we actually accept
(`\d{8,10}:[A-Za-z0-9_-]{35}`, `xoxb-`, `sk-`) and **refuses the turn** rather than
scrubbing silently.

### Conversation storage

Xperiment-owned tables via migration `0023`, not `@mastra/pg`'s `PostgresStore`: Mastra's tables
carry a free-text `resourceId` with no foreign key while every Xperiment table carries
`workspace_id` and `isolation.test.ts` is an IDOR matrix over it; `pruneExpired` names its
tables one by one, so one it does not know about is kept forever — and the transcript is
the table most likely to hold a credential somebody pasted despite being told not to;
`PostgresStore` creates its tables outside `runMigrations`' advisory lock and outside
`schema_migrations`, so `pnpm migrate` would stop reproducing the schema; and
`workspace_keys ON DELETE CASCADE` is what makes crypto-shredding work.

Redaction is made impossible to forget by moving `redactSecrets` into `packages/db` and
having `appendAgentMessage` call it internally.

## Verification

The exit criterion is the reported case, run by hand: an empty workspace, "remind me to
eat lunch at 12 via Telegram", and the agent must produce `schedule.trigger` +
`telegram.sendMessage` — not `core.transform`, not any node whose name contains
"placeholder" — save a draft, and then explain BotFather step by step. The transcript must
not contain the bot token, checked with `SELECT content, tool_calls FROM agent_messages`.
The workflow must still be a Draft with a null `active_version_id` afterwards.

Token cost of one full conversation is to be **measured and reported** against 6,800
tokens × 3 attempts on the old path. Moving the JSON Schemas behind `describe_node_type`
should make a ten-turn conversation cheaper than one shot is today. If it does not, that is
a finding to report, not to bury.
