# Xperiment Workflow Builder — Phase 0 Technical Proof

Deterministic workflow runtime: versioned Workflow IR, three services
(api / orchestrator / worker) over PostgreSQL + Redis/BullMQ, at-least-once
delivery with idempotency, automatic retry, and a full execution audit trail.

- Spec: `docs/superpowers/specs/2026-07-23-phase0-technical-proof-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-phase0-technical-proof.md`

## Prerequisites

- Node.js >= 20, pnpm >= 10, Docker Desktop

## Quickstart

```bash
docker compose up -d
pnpm install
pnpm migrate
```

Run the three services (three terminals):

```bash
pnpm --filter @xperiment/api dev
```

```bash
pnpm --filter @xperiment/orchestrator dev
```

```bash
pnpm --filter @xperiment/worker dev
```

Create, publish, and run a workflow:

```bash
pnpm xperiment workflow create --name "Lead check" --definition examples/lead-check.json
```

```bash
pnpm xperiment workflow publish <workflowId>
```

```bash
pnpm xperiment run <workflowId> --input payload.json --watch
```

with `payload.json` like `{ "name": "Budi", "total": 150 }`.

Set `HTTP_ALLOW_PRIVATE_IPS=true` on the worker when your workflow calls
localhost URLs (the SSRF guard blocks private ranges by default).

Note: Redis is exposed on host port **16379** (not 6379 — that port falls in a
Windows reserved range on the reference dev machine); `REDIS_URL` defaults
accordingly.

## Tests

```bash
docker compose up -d
```

```bash
pnpm test
```

```bash
pnpm test:cov
```

```bash
pnpm --filter @xperiment/e2e test
```

The e2e suite spawns all three services, drives them through the public API
against a local stub HTTP server, and includes the Phase 0 exit criterion:
the same workflow + input executed 5 times must produce identical terminal
results, plus worker-crash recovery via BullMQ stalled-job redelivery.

## Triggers (Phase 1A)

Webhook and schedule triggers start executions without `POST /execute`:

1. Build a workflow whose entrypoint is a `webhook.trigger`
   (`parameters: { authMode: 'none'|'token'|'hmac', idempotencyKeyPath?: 'event.id' }`)
   or `schedule.trigger` (`parameters: { cron: '*/5 * * * *', timezone?: 'Asia/Jakarta' }`;
   6-field seconds cron supported).
2. Publish it, then `POST /v1/workflows/:id/activate` — the response contains the
   production URL (`{GATEWAY_URL}/t/:routeKey`), a test URL (`/t/test/:routeKey`, works
   while inactive and records sample payloads), and the generated secret.
3. Sign production calls: `X-Xperiment-Signature: sha256=<hex(hmac-sha256(secret, rawBody))>`
   for `hmac` mode, or `Authorization: Bearer <secret>` for `token` mode.
4. Duplicate deliveries are deduped by `idempotencyKeyPath` → `Idempotency-Key` header →
   raw-body hash. `POST /v1/workflows/:id/deactivate` stops production traffic without
   touching definitions or running executions.

Run the two extra services alongside the core three:

```bash
pnpm --filter @xperiment/gateway dev
```

```bash
pnpm --filter @xperiment/scheduler dev
```

## Layout

```text
packages/  ir | expressions | engine-core | connectors | db | queue
apps/      api (3000) | orchestrator (3001) | worker (3002) | gateway (3003) | scheduler (3004) | cli
e2e/       end-to-end scenario suite
```
