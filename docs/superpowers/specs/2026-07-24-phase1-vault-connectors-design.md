# Phase 1 Sub-project B: Credential Vault + Connectors — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (Phase 0 + sub-project A merged); branch `feature/phase1-vault`
**PRD requirements covered:** SEC-001 (env-key AES-GCM now, KMS/envelope later), SEC-002,
SEC-003 (worker/log paths), SEC-006, CON-005, CON-008, CON-010, CON-014, CON-020.
Deferred: OAuth (SEC-005 — no Phase 1 connector needs it), sharing/grants (SEC-004 —
needs auth, sub-project C), short-lived grants (SEC-010 — mature), rotation (SEC-007).

---

## 1. Goal

Workflows call real external systems — PostgreSQL, Telegram, OpenAI, Gemini — with
credentials that never appear in the IR, logs, events, API responses, or stored
payloads.

## 2. Data model — migration `0003_connections.sql`

```sql
CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  connector_key TEXT NOT NULL,              -- 'postgres' | 'telegram' | 'openai' | 'gemini'
  name TEXT NOT NULL,
  encrypted_payload BYTEA NOT NULL,          -- AES-256-GCM (existing crypto helper)
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_connections_workspace ON connections (workspace_id, connector_key);
```

- Key: `sha256(CREDENTIALS_SECRET_KEY)` via the existing `deriveTriggerKey` helper
  (renamed conceptually: it derives any 32-byte key from an env string). Dev default in
  `.env.example`: `xperiment-dev-credentials-secret-change-me`. Distinct from
  `TRIGGER_SECRET_KEY`.
- Repository `packages/db/src/repos/connections.ts`:
  `createConnection`, `listConnections` (never returns payload), `getConnection`
  (returns `encryptedPayload` — worker/API-test use only), `deleteConnection`.

## 3. Connection payload shapes (zod, validated at create)

| connector_key | Payload |
|---|---|
| `postgres` | `{ connectionString: string }` |
| `telegram` | `{ botToken: string, baseUrl?: string }` |
| `openai` | `{ apiKey: string, baseUrl?: string }` |
| `gemini` | `{ apiKey: string, baseUrl?: string }` |

`baseUrl` overrides the provider endpoint (testing/self-hosted proxies). Defaults:
`https://api.telegram.org`, `https://api.openai.com`, `https://generativelanguage.googleapis.com`.

## 4. IR and validation

- `IRNode` gains optional `connectionRef?: string` (zod: uuid string).
- `ConnectorDefinition` gains optional `requiresConnection?: string` (a connector_key)
  and optional `testConnection?(payload: unknown): Promise<void>` (throws on failure).
- `NodeTypeInfo`/`RegistryLike` expose `requiresConnection` so validation can see it.
- New validation layer 5 (`layer: 'connections'`), active when the caller passes
  `connections: { id: string; connectorKey: string }[]` in `validateWorkflow` opts:
  - node whose type `requiresConnection` but has no `connectionRef` →
    `connection_required`;
  - `connectionRef` not in the list → `connection_not_found`;
  - connector_key mismatch → `connection_wrong_type`.
  API validate/publish pass the workspace's connections; publish therefore blocks
  workflows with unresolved credentials.

## 5. Connector nodes

| Type | Kind/effect | Params (expression-capable) | Output |
|---|---|---|---|
| `postgres.query` | action / read | `{ sql: string, params?: unknown[] }` | `{ rows: unknown[], rowCount: number }` |
| `telegram.sendMessage` | action / write | `{ chatId: string, text: string }` | `{ messageId: number }` |
| `openai.chat` | action / write | `{ prompt: string, model?: string ('gpt-4o-mini'), system?: string }` | `{ text: string }` |
| `gemini.generate` | action / write | `{ prompt: string, model?: string ('gemini-1.5-flash') }` | `{ text: string }` |

- `postgres.query` uses a throwaway `pg.Client` per run (connect → parameterized query →
  end), 10 s connect timeout, node `timeoutMs` governs the run via `AbortSignal`.
- HTTP connectors use `fetch` with `ctx.signal`; non-2xx → `NodeRunError('http_error',
  message-without-secrets, false, { httpStatus })` so the existing worker classifier
  applies the retry policy; network errors retryable as today.
- `testConnection`: postgres `SELECT 1`; telegram `GET /bot{token}/getMe`; openai
  `GET /v1/models`; gemini `GET /v1beta/models?key=...`.
- Error hygiene: messages are built from status codes/genericized text only; unit tests
  assert the secret never appears in thrown messages.

## 6. Worker changes

Before running a node whose connector `requiresConnection`:

1. `node.connectionRef` missing → fail `connection_required` (non-retryable).
2. Connection row missing/mismatched key → `connection_not_found` (non-retryable).
3. Decrypt failure → `connection_invalid` (non-retryable).
4. Success → `ctx.connection = decrypted payload` (in-memory only; never included in
   `input_json`, events, or logs — resolvedParams remain the only stored input).

## 7. API

```text
POST   /v1/connections          { connectorKey, name, payload } -> 201 row (no payload)
GET    /v1/connections          list (id, connectorKey, name, status, createdAt)
DELETE /v1/connections/:id      204 (409 problem if referenced by a published version's connectionRef)
POST   /v1/connections/:id/test { ok: true } | { ok: false, error } (error redacted)
```

Validate/publish routes now load `listConnections` and pass them to `validateWorkflow`.

## 8. Testing

- **Unit:** payload zod shapes; error-hygiene (no secret in messages); registry exposes
  `requiresConnection`; IR validation layer 5 matrix (required/missing/wrong-type/ok).
- **Integration:** connections repo round-trip (payload encrypted at rest — assert
  ciphertext differs from plaintext and decrypts back); API create/list/test/delete incl.
  no-payload-in-response and delete-conflict; `postgres.query` against the dockerized
  Postgres; `telegram.sendMessage`/`openai.chat`/`gemini.generate` against a local stub
  via `baseUrl`; worker connection resolution failure modes.
- **E2E (PRD §22 skeleton):** signed webhook → `postgres.query` (lead lookup in real PG)
  → `core.if` → `openai.chat` (stub) → `telegram.sendMessage` (stub) → SUCCEEDED, with
  assertions on the stub-received Telegram text containing data mapped from the webhook
  and the AI stub output.
- Coverage thresholds unchanged.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Secret leakage via error messages/logs | Status-code-only errors, redaction unit tests, connection payload never in stored inputs |
| Env-key crypto pre-KMS | Same explicit trade-off as sub-project A; storage-layer swap documented |
| Provider API drift | baseUrl-stubbed contract tests keep runtime logic verified without live keys |
| SQL misuse via postgres.query | Parameterized queries only; user targets their own DB; effectClass read by default |
