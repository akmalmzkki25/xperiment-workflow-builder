import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { midtransCreateTransaction, NodeRunError, xenditCreateInvoice } from '../src/index.js';
import type { NodeRunContext } from '../src/index.js';

let server: Server;
let baseUrl: string;
let lastReq: { path: string; auth: string | undefined; body: unknown } | null = null;
let status = 200;
let responseBody: unknown = {};

const SERVER_KEY = 'SB-Mid-server-FAKE-not-real';
const SECRET_KEY = 'xnd_development_FAKE_not_real';

function ctx(parameters: unknown, connection: unknown): NodeRunContext {
  return {
    executionId: 'e',
    nodeId: 'n',
    attempt: 1,
    parameters,
    triggerBody: null,
    connection,
    signal: AbortSignal.timeout(3000),
    log: () => {},
  };
}

const midtransConn = () => ({ serverKey: SERVER_KEY, baseUrl });
const xenditConn = () => ({ secretKey: SECRET_KEY, baseUrl });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      lastReq = { path: req.url ?? '', auth: req.headers['authorization'], body: raw.length ? JSON.parse(raw) : null };
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(responseBody));
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
  status = 200;
  responseBody = {};
  lastReq = null;
});

describe('midtrans.createTransaction', () => {
  const ok = { token: 'snap-token-1', redirect_url: 'https://app.sandbox.midtrans.com/snap/v3/redirection/snap-token-1' };

  test('creates a snap transaction and returns the payment page', async () => {
    responseBody = ok;
    const out = await midtransCreateTransaction.run(
      ctx({ orderId: 'INV-1', grossAmount: 56000 }, midtransConn()),
    );
    expect(out.output).toEqual({ token: 'snap-token-1', redirectUrl: ok.redirect_url, orderId: 'INV-1' });
    expect(lastReq?.path).toBe('/snap/v1/transactions');
    expect(lastReq?.body).toEqual({ transaction_details: { order_id: 'INV-1', gross_amount: 56000 } });
  });

  test('authenticates with the server key as the Basic username and an empty password', async () => {
    responseBody = ok;
    await midtransCreateTransaction.run(ctx({ orderId: 'INV-2', grossAmount: 1000 }, midtransConn()));
    expect(lastReq?.auth).toBe(`Basic ${Buffer.from(`${SERVER_KEY}:`, 'utf8').toString('base64')}`);
  });

  test('item details that do not sum to grossAmount are rejected before any request', async () => {
    // Midtrans answers 400 on a mismatch. Catching it here names the actual problem
    // instead of relaying a generic rejection, and costs no round trip.
    await expect(
      midtransCreateTransaction.run(
        ctx(
          {
            orderId: 'INV-3',
            grossAmount: 50000,
            itemDetails: [{ name: 'Keripik', price: 28000, quantity: 2 }],
          },
          midtransConn(),
        ),
      ),
    ).rejects.toBeInstanceOf(NodeRunError);
    expect(lastReq).toBeNull();
  });

  test('item details that do sum correctly are accepted', async () => {
    responseBody = ok;
    await midtransCreateTransaction.run(
      ctx(
        { orderId: 'INV-4', grossAmount: 56000, itemDetails: [{ name: 'Keripik', price: 28000, quantity: 2 }] },
        midtransConn(),
      ),
    );
    expect(lastReq?.body).toMatchObject({
      item_details: [{ id: 'Keripik', name: 'Keripik', price: 28000, quantity: 2 }],
    });
  });

  test('a 406 becomes a non-retryable duplicate_order rather than an http_error', async () => {
    // The load-bearing detail: the worker classifier overrides retryable for anything
    // carrying details.httpStatus, so leaving this as http_error would retry a duplicate
    // three times against a provider that will keep refusing it.
    status = 406;
    responseBody = { error_messages: ['transaction_details.order_id has already been taken'] };
    const err = (await midtransCreateTransaction
      .run(ctx({ orderId: 'INV-5', grossAmount: 1000 }, midtransConn()))
      .catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('duplicate_order');
    expect(err.retryable).toBe(false);
    expect((err.details as { httpStatus?: number } | undefined)?.httpStatus).toBeUndefined();
  });

  test('a 503 stays an http_error carrying the status', async () => {
    status = 503;
    const err = (await midtransCreateTransaction
      .run(ctx({ orderId: 'INV-6', grossAmount: 1000 }, midtransConn()))
      .catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('http_error');
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(503);
  });

  test('a 200 with no snap token fails rather than returning an unusable output', async () => {
    responseBody = { status_message: 'ok' };
    await expect(
      midtransCreateTransaction.run(ctx({ orderId: 'INV-7', grossAmount: 1000 }, midtransConn())),
    ).rejects.toBeInstanceOf(NodeRunError);
  });

  test('no failure message ever contains the server key', async () => {
    const dumps: string[] = [];
    status = 406;
    dumps.push(
      JSON.stringify(
        await midtransCreateTransaction
          .run(ctx({ orderId: 'INV-8', grossAmount: 1 }, midtransConn()))
          .catch((e: unknown) => ({ message: (e as Error).message, details: (e as NodeRunError).details })),
      ),
    );
    status = 500;
    dumps.push(
      JSON.stringify(
        await midtransCreateTransaction
          .run(ctx({ orderId: 'INV-9', grossAmount: 1 }, midtransConn()))
          .catch((e: unknown) => ({ message: (e as Error).message })),
      ),
    );
    dumps.push(
      JSON.stringify(
        await midtransCreateTransaction
          .run(ctx({ orderId: 'INV-10', grossAmount: 1 }, { serverKey: '' }))
          .catch((e: unknown) => ({ message: (e as Error).message })),
      ),
    );
    for (const dump of dumps) expect(dump).not.toContain(SERVER_KEY);
  });

  test('has no testConnection, deliberately', () => {
    // Snap offers no side-effect-free credential probe, and inventing one by POSTing a
    // throwaway transaction would leave real orders in a real merchant dashboard.
    expect(midtransCreateTransaction.testConnection).toBeUndefined();
  });

  test('a fractional amount is refused: IDR has no minor unit', async () => {
    await expect(
      midtransCreateTransaction.run(ctx({ orderId: 'INV-11', grossAmount: 1000.5 }, midtransConn())),
    ).rejects.toBeInstanceOf(NodeRunError);
  });
});

describe('xendit.createInvoice', () => {
  const ok = {
    id: 'inv_1',
    invoice_url: 'https://checkout.xendit.co/web/inv_1',
    status: 'PENDING',
    expiry_date: '2026-08-12T09:00:00.000Z',
  };

  test('creates an invoice and returns its payment url', async () => {
    responseBody = ok;
    const out = await xenditCreateInvoice.run(ctx({ externalId: 'ORD-1', amount: 132000 }, xenditConn()));
    expect(out.output).toEqual({
      invoiceId: 'inv_1',
      invoiceUrl: ok.invoice_url,
      status: 'PENDING',
      expiresAt: ok.expiry_date,
      externalId: 'ORD-1',
    });
    expect(lastReq?.path).toBe('/v2/invoices');
    expect(lastReq?.body).toEqual({ external_id: 'ORD-1', amount: 132000 });
  });

  test('authenticates with the secret key as the Basic username', async () => {
    responseBody = ok;
    await xenditCreateInvoice.run(ctx({ externalId: 'ORD-2', amount: 1000 }, xenditConn()));
    expect(lastReq?.auth).toBe(`Basic ${Buffer.from(`${SECRET_KEY}:`, 'utf8').toString('base64')}`);
  });

  test('optional fields are omitted rather than sent as null', async () => {
    responseBody = ok;
    await xenditCreateInvoice.run(
      ctx({ externalId: 'ORD-3', amount: 1000, payerEmail: 'a@b.co', invoiceDuration: 3600 }, xenditConn()),
    );
    expect(lastReq?.body).toEqual({
      external_id: 'ORD-3',
      amount: 1000,
      payer_email: 'a@b.co',
      invoice_duration: 3600,
    });
  });

  test('a 409 becomes a non-retryable duplicate_invoice with no httpStatus', async () => {
    status = 409;
    responseBody = { error_code: 'DUPLICATE_ERROR' };
    const err = (await xenditCreateInvoice
      .run(ctx({ externalId: 'ORD-4', amount: 1000 }, xenditConn()))
      .catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('duplicate_invoice');
    expect(err.retryable).toBe(false);
    expect((err.details as { httpStatus?: number } | undefined)?.httpStatus).toBeUndefined();
  });

  test('a 503 stays an http_error carrying the status', async () => {
    status = 503;
    const err = (await xenditCreateInvoice
      .run(ctx({ externalId: 'ORD-5', amount: 1000 }, xenditConn()))
      .catch((e: unknown) => e)) as NodeRunError;
    expect(err.code).toBe('http_error');
    expect((err.details as { httpStatus?: number }).httpStatus).toBe(503);
  });

  test('no failure message ever contains the secret key', async () => {
    const dumps: string[] = [];
    status = 409;
    dumps.push(
      JSON.stringify(
        await xenditCreateInvoice
          .run(ctx({ externalId: 'ORD-6', amount: 1 }, xenditConn()))
          .catch((e: unknown) => ({ message: (e as Error).message, details: (e as NodeRunError).details })),
      ),
    );
    status = 500;
    dumps.push(
      JSON.stringify(
        await xenditCreateInvoice
          .run(ctx({ externalId: 'ORD-7', amount: 1 }, xenditConn()))
          .catch((e: unknown) => ({ message: (e as Error).message })),
      ),
    );
    for (const dump of dumps) expect(dump).not.toContain(SECRET_KEY);
  });

  test('testConnection reads the balance and reports failure without leaking', async () => {
    responseBody = { balance: 0 };
    await expect(xenditCreateInvoice.testConnection!(xenditConn(), AbortSignal.timeout(3000))).resolves.toBeUndefined();
    expect(lastReq?.path).toBe('/balance');
    status = 401;
    const err = await xenditCreateInvoice
      .testConnection!(xenditConn(), AbortSignal.timeout(3000))
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).not.toContain(SECRET_KEY);
  });

  test('an invoice duration shorter than a minute is refused', async () => {
    await expect(
      xenditCreateInvoice.run(ctx({ externalId: 'ORD-8', amount: 1000, invoiceDuration: 30 }, xenditConn())),
    ).rejects.toBeInstanceOf(NodeRunError);
    expect(lastReq).toBeNull();
  });
});
