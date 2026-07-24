# Phase 2 Sub-project G: Beta Connectors — Design

**Project:** Xperiment Workflow Builder
**Date:** 2026-07-24
**Status:** Approved by user
**Base:** master (Phase 0 + Phase 1 A–E + Phase 2F merged); branch `feature/phase2-connectors`
**PRD requirements covered:** CON-006 (Gmail/SMTP), CON-007 (Google Sheets), CON-009
(WhatsApp Cloud API), CON-014 (test connection), CON-020 (operations never return raw
secrets).
**Non-goals (deferred):** interactive 3-legged Google OAuth + reconnect UX (CON-015) —
this slice uses a service-account key for Sheets and SMTP for email, no OAuth flow;
WhatsApp inbound trigger (needs Meta app verification + webhook challenge, PRD §21) —
deferred to the WhatsApp vertical pack (sub-project L); WhatsApp media/interactive
messages beyond text + named template.

---

## 1. Goal

Three credentialed action connectors — WhatsApp Cloud API, SMTP email, and Google Sheets
— usable from the canvas, AI builder, and API exactly like the existing telegram/openai/
gemini connectors, each with a working "Test connection".

## 2. Architecture

Each connector follows the established pattern in `@xperiment/connectors`: a `ConnectorDefinition`
with `requiresConnection`, a `paramsSchema`, a `run(ctx)` that reads the decrypted
`ctx.connection`, and a `testConnection(payload, signal)`. Connection payload shapes are
added to `CONNECTION_PAYLOAD_SCHEMAS` (validated by `POST /v1/connections`), stored
AES-256-GCM-encrypted, and decrypted just-in-time by the worker. Errors stay secret-free
(reuse `providerFetch`/`NodeRunError`; never echo tokens/keys — CON-020).

New connection keys: `whatsapp`, `smtp`, `googleSheets`. New deps: `nodemailer` (SMTP)
and a service-account JWT signer for Google (hand-rolled with `node:crypto` RS256 to avoid
a heavy dependency, or `google-auth-library` — decided in the plan; either way token
exchange is isolated behind one helper so tests can stub it).

## 3. Connectors

### 3.1 whatsapp.sendMessage
- Connection `whatsapp`: `{ accessToken, phoneNumberId, baseUrl? }` (baseUrl for stub tests;
  default `https://graph.facebook.com`).
- Params: `{ to: string, text?: string, templateName?: string, templateLangCode?: string }`
  — either a plain `text` body or a named `template` (Cloud API requires templates for
  business-initiated messages). Exactly one of `text`/`templateName` required.
- `run`: `POST {base}/v20.0/{phoneNumberId}/messages` with `Authorization: Bearer
  {accessToken}`; body is the text or template payload. Output `{ messageId }` from the
  response `messages[0].id`.
- `testConnection`: `GET {base}/v20.0/{phoneNumberId}?fields=id` with the bearer token.

### 3.2 email.send (SMTP)
- Connection `smtp`: `{ host, port, user, password, from, secure? }`.
- Params: `{ to: string, subject: string, text?: string, html?: string }` (one of
  text/html required).
- `run`: build a `nodemailer` transport from the connection and send; output
  `{ messageId, accepted }`. The transport is created per-run (no pooling) and closed after.
- `testConnection`: `transporter.verify()`.

### 3.3 Google Sheets (sheets.appendRow, sheets.getRows)
- Connection `googleSheets`: `{ serviceAccountEmail, privateKey, ... }` supplied as the
  service-account JSON key fields; scope `https://www.googleapis.com/auth/spreadsheets`.
- A shared `googleAccessToken(conn, signal)` helper signs an RS256 JWT and exchanges it at
  the Google OAuth token endpoint (`https://oauth2.googleapis.com/token`, overridable via a
  `tokenUrl` for tests) for a short-lived bearer token.
- `sheets.appendRow` params: `{ spreadsheetId, range, values: unknown[] }` →
  `POST {base}/v4/spreadsheets/{id}/values/{range}:append?valueInputOption=USER_ENTERED`.
  Output `{ updatedRange, updatedRows }`.
- `sheets.getRows` params: `{ spreadsheetId, range }` →
  `GET {base}/v4/spreadsheets/{id}/values/{range}`. Output `{ rows }`. Effect `read`.
- `testConnection`: fetch a token, then `GET {base}/v4/spreadsheets/{id}?fields=spreadsheetId`
  where `id` is a `testSpreadsheetId` in the connection payload (or the token exchange alone
  if none). Google API base overridable via `baseUrl` for stub tests.

## 4. Registry, catalog, validation

All connectors registered in `createDefaultRegistry` and thereby surfaced in the connector
catalog (`GET /v1/connectors`) → the canvas node library, schema-driven forms, and AI
prompt pick them up with no per-connector UI. Publish-time connection validation (IR layer
5) already gates any node with `requiresConnection` — `whatsapp`/`smtp`/`googleSheets`
join `postgres`/`telegram`/`openai`/`gemini` automatically. The connections UI's
client-declared field map (`connectionFields.ts`) gains the three new keys (password-typed
for secrets, never echoed after save).

## 5. Testing

- **Unit (`@xperiment/connectors`, ≥80%):** each connector against a stub HTTP server (baseUrl/
  tokenUrl overrides) — happy path output shape, param validation errors, provider-error
  mapping (non-2xx → non-retryable `provider_error`), and `testConnection` success/failure.
  SMTP tested against a stub SMTP server (or nodemailer's JSON transport / a mock) — no real
  mail. The Google JWT signer tested for a well-formed assertion; token exchange stubbed.
- **Secret hygiene:** assert `accessToken`/`password`/`privateKey` never appear in any
  `NodeRunError` message or connector output (CON-020).
- **API (`@xperiment/api`):** `POST /v1/connections` accepts the three new keys and rejects
  malformed payloads; `POST /v1/connections/:id/test` routes to each connector's
  `testConnection` (against stubs).
- **Catalog:** the catalog now lists 16 connectors, including the three new ones with their
  `requiresConnection` keys and param schemas.
- **e2e:** extend the acceptance suite — build a workflow using `whatsapp.sendMessage`
  against a WhatsApp stub, assert the run succeeds and the stored input/output carry no
  secret. (SMTP/Sheets covered at unit level to avoid standing up an SMTP server in e2e.)
- No live provider calls anywhere.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Service-account private key handling | Stored in the vault (encrypted), decrypted in-memory only, never in output/logs/errors; secret-hygiene tests |
| Google token exchange non-determinism in tests | Token exchange isolated behind one helper with an overridable `tokenUrl`; stubbed in tests |
| nodemailer pulling a large dep tree | Acceptable for SMTP; transport created per-run and closed; no connection pooling to leak |
| WhatsApp template vs text rules | Params require exactly one of text/templateName; template path documented; business-initiated messaging nuances are the user's Meta-side concern |
| SSRF via connection `baseUrl` | Same posture as existing provider connectors (builder-gated connection creation); provider connectors intentionally allow baseUrl override for stubbed testing |
