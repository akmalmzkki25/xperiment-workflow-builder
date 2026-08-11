import { fakeHost, fakeSecret } from './guard.js';

/**
 * What the demo workspace contains.
 *
 * Kept as plain data, separate from the code that writes it, so the shape of the demo
 * is reviewable on its own. The scenario is a small Indonesian online shop, because a
 * demo full of `foo` and `test-workflow-1` teaches nobody what the product is for.
 */

export interface SeedWorkflow {
  slug: string;
  name: string;
  /** Rough share of the seeded runs that belong to this workflow. */
  weight: number;
  definition: Record<string, unknown>;
  /**
   * What the run timeline shows.
   *
   * Written by hand rather than generated: the payload panel is the whole point of
   * opening a run, and a demo whose nodes have empty payloads demonstrates the feature
   * is missing rather than present.
   */
  sample: { trigger: unknown; outputs: Record<string, unknown> };
}

export interface SeedConnection {
  connectorKey: string;
  name: string;
  payload: Record<string, unknown>;
}

const trigger = (id: string) => ({
  id,
  kind: 'trigger',
  type: 'webhook.trigger',
  operationVersion: '0.1.0',
  parameters: { authMode: 'none' },
});

export const SEED_WORKFLOWS: SeedWorkflow[] = [
  {
    slug: 'pesanan-baru',
    name: 'Pesanan baru → WhatsApp',
    weight: 5,
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wf_pesanan_baru', name: 'Pesanan baru → WhatsApp' },
      entrypoints: ['order_masuk'],
      nodes: [
        trigger('order_masuk'),
        {
          id: 'susun_pesan',
          kind: 'logic',
          type: 'core.transform',
          operationVersion: '0.1.0',
          parameters: {
            fields: {
              nomor: '{{ trigger.body.customer.phone }}',
              teks: 'Terima kasih {{ trigger.body.customer.name }}! Pesanan {{ trigger.body.order_id }} sedang kami siapkan.',
            },
          },
        },
      ],
      edges: [
        {
          id: 'e_order_masuk_main_susun_pesan',
          from: { nodeId: 'order_masuk', port: 'main' },
          to: { nodeId: 'susun_pesan', port: 'input' },
        },
      ],
      metadata: { layout: { order_masuk: { x: 120, y: 160 }, susun_pesan: { x: 440, y: 160 } } },
    },
    sample: {
      trigger: {
        body: {
          order_id: 'INV-20260811-0042',
          customer: { name: 'Siti Rahmawati', phone: '628123456789' },
          items: [{ sku: 'KRP-500', name: 'Keripik singkong 500g', qty: 2, price: 28000 }],
          total: 56000,
        },
      },
      outputs: {
        susun_pesan: {
          fields: {
            nomor: '628123456789',
            teks: 'Terima kasih Siti Rahmawati! Pesanan INV-20260811-0042 sedang kami siapkan.',
          },
        },
      },
    },
  },
  {
    slug: 'stok-menipis',
    name: 'Stok menipis → tim gudang',
    weight: 3,
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wf_stok_menipis', name: 'Stok menipis → tim gudang' },
      entrypoints: ['cek_stok'],
      nodes: [
        trigger('cek_stok'),
        {
          id: 'saring_menipis',
          kind: 'logic',
          type: 'core.filter',
          operationVersion: '0.1.0',
          parameters: { items: '{{ trigger.body.items }}', field: 'stock', op: 'lt', value: 5 },
        },
      ],
      edges: [
        {
          id: 'e_cek_stok_main_saring_menipis',
          from: { nodeId: 'cek_stok', port: 'main' },
          to: { nodeId: 'saring_menipis', port: 'input' },
        },
      ],
      metadata: { layout: { cek_stok: { x: 120, y: 160 }, saring_menipis: { x: 440, y: 160 } } },
    },
    sample: {
      trigger: {
        body: {
          gudang: 'Gudang Utama',
          items: [
            { sku: 'KRP-500', name: 'Keripik singkong 500g', stock: 3 },
            { sku: 'SBL-250', name: 'Sambal roa 250g', stock: 41 },
            { sku: 'KCG-100', name: 'Kacang telur 100g', stock: 2 },
          ],
        },
      },
      outputs: {
        saring_menipis: {
          items: [
            { sku: 'KRP-500', name: 'Keripik singkong 500g', stock: 3 },
            { sku: 'KCG-100', name: 'Kacang telur 100g', stock: 2 },
          ],
          count: 2,
        },
      },
    },
  },
  {
    slug: 'rekap-harian',
    name: 'Rekap penjualan harian',
    weight: 2,
    definition: {
      schemaVersion: '0.1',
      workflow: { id: 'wf_rekap_harian', name: 'Rekap penjualan harian' },
      entrypoints: ['tiap_malam'],
      nodes: [
        trigger('tiap_malam'),
        {
          id: 'jumlahkan',
          kind: 'logic',
          type: 'core.aggregate',
          operationVersion: '0.1.0',
          parameters: { items: '{{ trigger.body.orders }}', operation: 'sum', field: 'total' },
        },
      ],
      edges: [
        {
          id: 'e_tiap_malam_main_jumlahkan',
          from: { nodeId: 'tiap_malam', port: 'main' },
          to: { nodeId: 'jumlahkan', port: 'input' },
        },
      ],
      metadata: { layout: { tiap_malam: { x: 120, y: 160 }, jumlahkan: { x: 440, y: 160 } } },
    },
    sample: {
      trigger: {
        body: {
          tanggal: '2026-08-10',
          orders: [
            { order_id: 'INV-20260810-0039', total: 56000 },
            { order_id: 'INV-20260810-0040', total: 132000 },
            { order_id: 'INV-20260810-0041', total: 27500 },
          ],
        },
      },
      outputs: { jumlahkan: { operation: 'sum', value: 215500, count: 3, skipped: 0 } },
    },
  },
];

/**
 * What a failed demo run says.
 *
 * Codes match the ones the worker actually classifies, and every host is `.invalid`, so
 * nobody reads a demo error and goes looking for a real outage.
 */
export const SEED_FAILURES: readonly { code: string; message: string }[] = [
  { code: 'http_error', message: 'http_error: 503 dari graph.fake.invalid' },
  { code: 'timeout', message: 'timeout: node tidak merespons dalam 30 detik' },
  { code: 'expression_error', message: 'expression_error: field `total` tidak ada di payload' },
  { code: 'http_error', message: 'http_error: 429 dari telegram.fake.invalid' },
];

/**
 * Connections whose payloads PARSE but cannot reach anything.
 *
 * Every credential carries the FAKE marker and every host is under `.invalid`, which
 * RFC 2606 guarantees can never resolve. A demo that could actually call a provider is
 * a demo that eventually sends a real message to a real person.
 */
export const SEED_CONNECTIONS: SeedConnection[] = [
  {
    connectorKey: 'telegram',
    name: 'Bot toko (demo)',
    payload: { botToken: fakeSecret('telegram'), baseUrl: `https://${fakeHost('telegram')}` },
  },
  {
    connectorKey: 'whatsapp',
    name: 'WhatsApp Cloud (demo)',
    payload: {
      accessToken: fakeSecret('whatsapp'),
      phoneNumberId: '000000000000000',
      baseUrl: `https://${fakeHost('graph')}`,
    },
  },
];

/**
 * The status mix seeded runs are drawn from.
 *
 * Not all SUCCEEDED: a dashboard that has never seen a failure teaches an operator
 * nothing about what a failure looks like, and the run list, the status filter and the
 * failure-rate alert all have nothing to show.
 */
export const SEED_STATUS_MIX: readonly { status: string; weight: number }[] = [
  { status: 'SUCCEEDED', weight: 82 },
  { status: 'FAILED', weight: 11 },
  { status: 'RUNNING', weight: 4 },
  { status: 'CANCELED', weight: 3 },
];

/** Pick from a weighted list using a caller-supplied fraction in [0, 1). */
export function weightedPick<T extends { weight: number }>(items: readonly T[], fraction: number): T {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let target = Math.min(Math.max(fraction, 0), 0.999999) * total;
  for (const item of items) {
    target -= item.weight;
    if (target < 0) return item;
  }
  return items[items.length - 1] as T;
}
