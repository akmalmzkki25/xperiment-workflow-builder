'use client';

import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { getBrowserClient, type ImportResult, type WorkflowExportDoc } from '../../lib/api';
import { parseExportFile } from '../../lib/portableFile';
import { Dialog } from '../common/Dialog';

const REASONS: Record<string, string> = {
  too_large: 'That file is too large to be a workflow export.',
  not_json: 'That file is not JSON.',
  not_an_export: 'That is not a Xperiment workflow export.',
  unsupported_format: 'That file was written by a newer Xperiment. Update, then try again.',
};

/**
 * Import a `.xperiment.json`.
 *
 * A file input rather than a paste box: a workflow document is a file people keep, and
 * the browser's own picker is the only part of this the operating system should own.
 */
export function ImportButton({ onImported }: { onImported: () => void }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const run = useMutation({
    mutationFn: (doc: WorkflowExportDoc) => getBrowserClient().importWorkflow(doc),
    onSuccess: (r) => {
      onImported();
      // A wired import goes straight to the canvas; one needing credentials stops here,
      // because the list of nodes to reconnect is the whole reason it stopped.
      if (r.reconnect.length === 0) router.push(`/workflows/${r.id}`);
      else setResult(r);
    },
  });

  async function pick(file: File) {
    setFileError(null);
    const parsed = parseExportFile(await file.text());
    if (!parsed.ok) {
      setFileError(REASONS[parsed.reason] ?? 'That file could not be read.');
      return;
    }
    run.mutate(parsed.doc);
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        data-testid="wf-import-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so picking the same file twice in a row still fires a change event.
          e.target.value = '';
          if (file) void pick(file);
        }}
      />
      <Button variant="ghost"
        
        data-testid="wf-import"
        disabled={run.isPending}
        onClick={() => input.current?.click()}
      >
        {run.isPending ? 'Importing…' : 'Import'}
      </Button>

      {fileError ? (
        <div className="q-banner" data-testid="wf-import-error">
          {fileError}
        </div>
      ) : null}
      {run.isError ? <div className="q-banner">{(run.error as Error).message}</div> : null}

      <Dialog
        title="Imported — some nodes need a connection"
        open={result !== null}
        onClose={() => setResult(null)}
        actions={
          <Button
            
            data-testid="wf-import-open"
            onClick={() => {
              if (result) router.push(`/workflows/${result.id}`);
            }}
          >
            Open workflow
          </Button>
        }
      >
        <p style={{ color: 'var(--text-muted)' }}>
          Credentials never travel in an export. These nodes each need a connection in this workspace before the
          workflow can be published:
        </p>
        <ul data-testid="wf-import-reconnect">
          {(result?.reconnect ?? []).map((r) => (
            <li key={r.nodeId}>
              <span className="mono">{r.nodeId}</span> — {r.connectorKey}
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
