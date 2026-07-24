import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildServiceAccountJwt, NodeRunError, sheetsAppendRow, sheetsGetRows } from '../src/index.js';
import type { NodeRunContext } from '../src/index.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let server: Server;
let baseUrl: string;
let lastToken: string | undefined;
let lastSheetsReq: { path: string; method: string; auth: string | undefined; body: unknown } | null = null;
let sheetsResponse: unknown = { updates: { updatedRange: 'Sheet1!A1', updatedRows: 1 } };

const conn = () => ({
  serviceAccountEmail: 'svc@proj.iam.gserviceaccount.com',
  privateKey: PRIVATE_PEM,
  baseUrl,
  tokenUrl: `${baseUrl}/token`,
});

const ctx = (parameters: unknown): NodeRunContext => ({
  executionId: 'e',
  nodeId: 'n',
  attempt: 1,
  parameters,
  triggerBody: null,
  connection: conn(),
  signal: AbortSignal.timeout(3000),
  log: () => {},
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        const params = new URLSearchParams(raw);
        lastToken = params.get('assertion') ?? undefined;
        res.end(JSON.stringify({ access_token: 'ya29.fake-token', expires_in: 3600 }));
        return;
      }
      lastSheetsReq = {
        path: req.url ?? '',
        method: req.method ?? '',
        auth: req.headers['authorization'],
        body: raw.length ? JSON.parse(raw) : null,
      };
      res.end(JSON.stringify(sheetsResponse));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  lastToken = undefined;
  lastSheetsReq = null;
  sheetsResponse = { updates: { updatedRange: 'Sheet1!A1', updatedRows: 1 } };
});

describe('buildServiceAccountJwt', () => {
  test('produces a verifiable RS256 assertion with the right claims', () => {
    const jwt = buildServiceAccountJwt({
      email: 'svc@x.iam',
      privateKey: PRIVATE_PEM,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      now: 1_700_000_000_000,
    });
    const [header, claims, signature] = jwt.split('.');
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature!, 'base64url'),
    );
    expect(ok).toBe(true);
    const decoded = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { iss: string; iat: number; exp: number };
    expect(decoded.iss).toBe('svc@x.iam');
    expect(decoded.exp - decoded.iat).toBe(3600);
  });
});

describe('sheets.appendRow', () => {
  test('exchanges a JWT for a token then appends the row', async () => {
    const out = await sheetsAppendRow.run(ctx({ spreadsheetId: 'sheet-1', range: 'A1', values: ['Budi', 42] }));
    expect(out.output).toEqual({ updatedRange: 'Sheet1!A1', updatedRows: 1 });
    expect(lastToken).toBeDefined(); // token exchange happened
    expect(lastSheetsReq?.method).toBe('POST');
    expect(lastSheetsReq?.path).toContain('/v4/spreadsheets/sheet-1/values/A1:append');
    expect(lastSheetsReq?.auth).toBe('Bearer ya29.fake-token');
    expect(lastSheetsReq?.body).toEqual({ values: [['Budi', 42]] });
  });

  test('an invalid service-account key fails with connection_invalid', async () => {
    const badCtx = { ...ctx({ spreadsheetId: 's', range: 'A1', values: [] }), connection: { ...conn(), privateKey: 'not-a-key' } };
    await expect(sheetsAppendRow.run(badCtx)).rejects.toMatchObject({ code: 'connection_invalid' });
  });

  test('never leaks the private key material in an error', async () => {
    const err = await sheetsAppendRow
      .run({ ...ctx({ spreadsheetId: 's', range: 'A1', values: [] }), connection: { ...conn(), privateKey: 'SECRET-KEY-MATERIAL' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeRunError);
    expect((err as NodeRunError).message).not.toContain('SECRET-KEY-MATERIAL');
  });
});

describe('sheets.getRows', () => {
  test('returns the values array', async () => {
    sheetsResponse = { values: [['a', 'b'], ['c', 'd']] };
    const out = await sheetsGetRows.run(ctx({ spreadsheetId: 'sheet-1', range: 'A1:B2' }));
    expect(out.output).toEqual({ rows: [['a', 'b'], ['c', 'd']] });
    expect(lastSheetsReq?.method).toBe('GET');
  });

  test('testConnection exchanges a token', async () => {
    await expect(sheetsGetRows.testConnection!(conn(), AbortSignal.timeout(3000))).resolves.toBeUndefined();
    expect(lastToken).toBeDefined();
  });
});
