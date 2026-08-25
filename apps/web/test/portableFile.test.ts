import { describe, expect, test } from 'vitest';
import { exportFilename, MAX_IMPORT_BYTES, parseExportFile } from '../src/lib/portableFile';

const doc = { xperimentExport: 1, name: 'Pesanan baru', definition: { nodes: [] }, requiredConnections: [] };

describe('parseExportFile', () => {
  test('accepts a document this build understands', () => {
    const r = parseExportFile(JSON.stringify(doc));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.name).toBe('Pesanan baru');
  });

  test('a file written before the rename still opens', () => {
    // Exports on people's disks say `xperimentExport`. Refusing them would make renaming the
    // product cost them their saved workflows.
    const legacy = { xperimentExport: 1, name: 'Pesanan lama', definition: { nodes: [] }, requiredConnections: [] };
    const r = parseExportFile(JSON.stringify(legacy));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.name).toBe('Pesanan lama');
  });

  test('a file that is not JSON says so, rather than throwing at the caller', () => {
    const r = parseExportFile('{not json');
    expect(r).toEqual({ ok: false, reason: 'not_json' });
  });

  test('some other JSON file is refused before it reaches the server', () => {
    // Picking package.json by mistake is the likeliest wrong file in the folder.
    expect(parseExportFile('{"name":"x","version":"1.0.0"}')).toEqual({ ok: false, reason: 'not_an_export' });
  });

  test('a newer format is named as such, so the message can say "update Xperiment"', () => {
    const r = parseExportFile(JSON.stringify({ ...doc, xperimentExport: 2 }));
    expect(r).toEqual({ ok: false, reason: 'unsupported_format', found: 2 });
  });

  test('an oversized file is refused before JSON.parse blocks the tab', () => {
    const big = `{"xperimentExport":1,"name":"x","definition":{},"padding":"${'a'.repeat(MAX_IMPORT_BYTES)}"}`;
    expect(parseExportFile(big)).toEqual({ ok: false, reason: 'too_large' });
  });

  test('a definition that is not an object is refused', () => {
    expect(parseExportFile(JSON.stringify({ ...doc, definition: 'nope' }))).toEqual({
      ok: false,
      reason: 'not_an_export',
    });
  });

  test('a missing manifest becomes an empty one rather than undefined', () => {
    // The manifest is informational; the server re-derives it. A file without one is
    // still importable, and the UI must not read `.length` of undefined.
    const r = parseExportFile(JSON.stringify({ xperimentExport: 1, name: 'x', definition: {} }));
    expect(r.ok && r.doc.requiredConnections).toEqual([]);
  });
});

describe('exportFilename', () => {
  test('turns a name into something a file system will accept', () => {
    expect(exportFilename('Pesanan baru → WhatsApp')).toBe('pesanan-baru-whatsapp.xperiment.json');
  });

  test('a name with nothing usable still produces a file name', () => {
    expect(exportFilename('日本語')).toBe('workflow.xperiment.json');
  });
});
