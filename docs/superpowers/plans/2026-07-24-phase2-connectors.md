# Phase 2 Sub-project G: Beta Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution). Steps use checkbox (`- [ ]`) syntax.

**Goal:** WhatsApp Cloud API, SMTP email, and Google Sheets action connectors, each with a test-connection, surfaced everywhere via the existing catalog.

**Architecture:** Follow the established `@xperiment/connectors` pattern (ConnectorDefinition + requiresConnection + paramsSchema + run + testConnection). Add three connection payload schemas; connectors decrypt `ctx.connection` at run time; errors stay secret-free. Google Sheets auths via a hand-rolled RS256 service-account JWT exchanged for a bearer token behind one stubbable helper.

**Tech Stack:** tsx-run TS, zod, nodemailer, node:crypto (RS256 JWT), vitest (80%).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-phase2-connectors-design.md`.
- Conventional commits, no attribution trailer. No console.log. No hardcoded secrets. Immutable updates.
- CON-020: no connector operation, output, log, or error may contain a raw secret (accessToken/password/privateKey). Reuse `providerFetch`/`NodeRunError` secret-free errors.
- Connection payload validation lives in `CONNECTION_PAYLOAD_SCHEMAS`; the generic `POST /v1/connections` + `/test` already route by connectorKey.
- baseUrl/tokenUrl overridable on every connector for stub tests; no live provider calls in any test.
- New connection keys: `whatsapp`, `smtp`, `googleSheets`. Coverage ≥80% all touched packages; typecheck clean; both e2e suites green.

## File Structure

```
packages/connectors/src/payloads.ts                 modify: whatsapp/smtp/googleSheets schemas
packages/connectors/src/whatsapp/sendMessage.ts      create
packages/connectors/src/email/send.ts                create
packages/connectors/src/google/jwt.ts                create: serviceAccountToken helper
packages/connectors/src/google/sheetsAppendRow.ts    create
packages/connectors/src/google/sheetsGetRows.ts      create
packages/connectors/src/registry.ts                  modify: register the four
packages/connectors/src/index.ts                     modify: exports
apps/web/src/lib/connectionFields.ts                 modify: 3 new key field maps
apps/api/test/connections.test.ts                    modify: new keys accepted + test routing
e2e/test/acceptance.test.ts (or new)                 modify: whatsapp send acceptance
README.md                                            modify: connectors list
```

---

### Task G-1: Payload schemas + whatsapp.sendMessage

**Files:**
- Modify: `packages/connectors/src/payloads.ts` (add `whatsapp`, `smtp`, `googleSheets`)
- Create: `packages/connectors/src/whatsapp/sendMessage.ts`; register + export
- Test: `packages/connectors/test/whatsapp.test.ts`; extend `catalog.test.ts`

**Interfaces:**
```ts
// payloads.ts additions to CONNECTION_PAYLOAD_SCHEMAS
whatsapp: z.object({ accessToken: z.string().min(1), phoneNumberId: z.string().min(1), baseUrl: z.string().url().optional() }).strict()
smtp: z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535), user: z.string().min(1), password: z.string().min(1), from: z.string().min(1), secure: z.boolean().optional() }).strict()
googleSheets: z.object({ serviceAccountEmail: z.string().email(), privateKey: z.string().min(1), baseUrl: z.string().url().optional(), tokenUrl: z.string().url().optional(), testSpreadsheetId: z.string().optional() }).strict()
// whatsapp.sendMessage: params { to: string.min1, text?: string.min1, templateName?: string.min1, templateLangCode?: string.default('en_US') } .strict + .refine(exactly one of text|templateName)
//   run: POST {base||graph}/v20.0/{phoneNumberId}/messages, Authorization Bearer; body text or template; output { messageId: response.messages[0].id }
//   testConnection: GET {base}/v20.0/{phoneNumberId}?fields=id (providerCheck with bearer header)
//   DEFAULT_BASE 'https://graph.facebook.com'
```

- [ ] Failing tests (stub http server, baseUrl override): text send returns `{ messageId }` from `messages[0].id`; template send hits the same endpoint with a `template` body; missing both text+templateName → `NodeRunError('invalid_parameters')`; non-2xx → `provider_error`; `testConnection` ok/fail; **secret hygiene**: accessToken absent from any error/output. Catalog lists 14 now, whatsapp present with `requiresConnection:'whatsapp'`.
- [ ] Run → FAIL → implement → PASS; coverage ≥80%.
- [ ] Commit `feat: add whatsapp.sendMessage connector`.

### Task G-2: email.send (SMTP)

**Files:**
- Create: `packages/connectors/src/email/send.ts`; register + export; add `nodemailer` + `@types/nodemailer` deps
- Test: `packages/connectors/test/email.test.ts`

**Interfaces:**
```ts
// email.send: params { to: string.min1, subject: string.min1, text?: string, html?: string } .strict + refine(one of text|html)
//   run: nodemailer.createTransport({ host, port, secure, auth:{ user, pass:password } }); sendMail({ from, to, subject, text?, html? }); output { messageId, accepted }; close transport in finally
//   testConnection: createTransport(...).verify()
//   Inject a transportFactory for tests (default nodemailer.createTransport) so a fake transport asserts the call without a real SMTP server.
export interface EmailDeps { transportFactory?: (opts: unknown) => { sendMail(msg: unknown): Promise<{ messageId: string; accepted: string[] }>; verify(): Promise<true>; close?(): void } }
export function createEmailSend(deps?: EmailDeps): ConnectorDefinition
```
- The registry builds `createEmailSend()` with the real nodemailer factory; tests pass a fake.

- [ ] Failing tests (fake transport): sends with the right from/to/subject/body and returns `{ messageId, accepted }`; missing text+html → invalid_parameters; connection-invalid payload → connection_invalid; `testConnection` calls verify; **secret hygiene**: password never in output/error.
- [ ] Run → FAIL → implement → PASS; coverage ≥80%.
- [ ] Commit `feat: add email.send SMTP connector`.

### Task G-3: Google Sheets (JWT + appendRow + getRows)

**Files:**
- Create: `packages/connectors/src/google/jwt.ts`, `google/sheetsAppendRow.ts`, `google/sheetsGetRows.ts`; register + export
- Test: `packages/connectors/test/googleSheets.test.ts`

**Interfaces:**
```ts
// jwt.ts
export function buildServiceAccountJwt(args: { email: string; privateKey: string; scope: string; aud: string; now: number }): string
//   RS256: base64url({alg:RS256,typ:JWT}).base64url({iss:email,scope,aud,iat:now,exp:now+3600}).sign(node:crypto createSign RSA-SHA256, privateKey)
export async function serviceAccountToken(conn: { serviceAccountEmail; privateKey; tokenUrl? }, signal: AbortSignal): Promise<string>
//   POST tokenUrl||'https://oauth2.googleapis.com/token' form-urlencoded grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>; returns access_token; secret-free errors
// sheets.appendRow: params { spreadsheetId, range, values: array } effect write
//   token = serviceAccountToken(conn); POST {base}/v4/spreadsheets/{id}/values/{range}:append?valueInputOption=USER_ENTERED, Bearer, body { values:[values] }; output { updatedRange, updatedRows }
// sheets.getRows: params { spreadsheetId, range } effect read
//   GET {base}/v4/spreadsheets/{id}/values/{range}, Bearer; output { rows: response.values ?? [] }
// testConnection: serviceAccountToken then (if testSpreadsheetId) GET {base}/v4/spreadsheets/{id}?fields=spreadsheetId
// DEFAULT_BASE 'https://sheets.googleapis.com'
```

- [ ] Failing tests: `buildServiceAccountJwt` produces a token that `crypto.verify`s against the matching public key and decodes to the right claims (generate an RSA keypair in the test); `serviceAccountToken` posts the assertion to the (stubbed) tokenUrl and returns the token; `sheets.appendRow` posts values and returns `{updatedRange,updatedRows}` (stub sheets + token servers); `sheets.getRows` returns `{rows}`; param validation errors; **secret hygiene**: privateKey never in output/error.
- [ ] Run → FAIL → implement → PASS; coverage ≥80%.
- [ ] Commit `feat: add Google Sheets connectors with service-account auth`.

### Task G-4: Wiring — web fields, API tests, e2e, docs, verify, merge

**Files:**
- Modify: `apps/web/src/lib/connectionFields.ts` (whatsapp: accessToken[secret]/phoneNumberId/baseUrl?; smtp: host/port/user/password[secret]/from/secure?; googleSheets: serviceAccountEmail/privateKey[secret]/baseUrl?/tokenUrl?/testSpreadsheetId?) + extend `connectionFields.test.ts`
- Modify: `apps/api/test/connections.test.ts` (create + test the new keys against stubs)
- Modify: `e2e/test/` — a WhatsApp send acceptance scenario (WhatsApp stub server, build `manual→whatsapp.sendMessage`, run, assert SUCCEEDED + no secret in stored input)
- Modify: `README.md` (Connections list: add whatsapp/smtp/googleSheets)

- [ ] Extend web `connectionFields.test.ts` (all 7 keys present, secret fields flagged); `apps/web` vitest + typecheck green.
- [ ] API connections test: new keys accepted, malformed rejected, `/test` routes to each connector.
- [ ] Catalog test asserts 16 connectors total.
- [ ] e2e whatsapp acceptance green.
- [ ] Full verification: `pnpm run test:cov` exit 0 (all ≥80%), `pnpm typecheck` exit 0, `pnpm --filter @xperiment/e2e test` green, `pnpm --filter @xperiment/web e2e` green.
- [ ] Commit `feat: wire beta connectors into web fields and e2e` then `docs: document beta connectors`.
- [ ] Adversarial review (security: SSRF via baseUrl/tokenUrl, secret leakage, JWT correctness; correctness: template-vs-text, token exchange, sheets range handling; TS; test-gaps). Fix confirmed findings; re-verify.
- [ ] Fast-forward merge `feature/phase2-connectors` → master; delete branch.

## Self-Review Notes

- Every connector isolates its network base behind an overridable `baseUrl`/`tokenUrl`, so all tests run against local stubs — no live WhatsApp/Google/SMTP calls.
- Google token exchange is one helper; the RS256 JWT is unit-tested by round-tripping against a generated public key, decoupling it from Google.
- SMTP uses an injectable transport factory so the connector is tested without a real mail server.
- Secret-hygiene assertions per connector enforce CON-020 (no accessToken/password/privateKey in outputs or errors).
- All four connectors flow into the catalog automatically → canvas, AI, and forms need no per-connector code (only the client-side connection field map is declared).
