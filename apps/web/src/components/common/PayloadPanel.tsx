'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { getBrowserClient } from '../../lib/api';
import { formatBytes, previewPayload } from '../../lib/payloadView';

interface Props {
  executionId: string;
  nodeId: string;
  attempt: number;
}

/**
 * The recorded input and output for one node attempt, fetched when it is opened.
 *
 * On demand rather than as part of the execution detail: that response has no row limit
 * — a loop of 1000 iterations times 10 attempts is thousands of rows at up to 512 KiB
 * each — and the UI polls it every two seconds while the run is live. Carrying payloads
 * there would re-read, re-clone and re-serialise megabytes on a timer. One human opening
 * one disclosure fetches one row.
 */
export function PayloadPanel({ executionId, nodeId, attempt }: Props) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['node-payload', executionId, nodeId, attempt],
    queryFn: () => getBrowserClient().getNodePayload(executionId, nodeId, attempt),
    enabled: open,
    // A finished attempt's payload never changes, so it never needs refetching.
    staleTime: Infinity,
  });

  const testId = `payload-${nodeId}-${attempt}`;

  return (
    <details
      data-testid={testId}
      style={{ width: '100%' }}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Data in and out</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
        {q.isPending && open ? <span className="q-field__hint">Loading…</span> : null}
        {q.isError ? (
          <span className="q-field__error" data-testid={`${testId}-error`}>
            Could not load this payload.
          </span>
        ) : null}
        {q.data ? (
          <>
            <PayloadBody label="Input" value={q.data.inputJson} testId={`${testId}-in`} />
            <PayloadBody label="Output" value={q.data.outputJson} testId={`${testId}-out`} />
          </>
        ) : null}
      </div>
    </details>
  );
}

function PayloadBody({ label, value, testId }: { label: string; value: unknown; testId: string }) {
  const preview = previewPayload(value);
  if (preview.empty) {
    return (
      <span className="q-field__hint" data-testid={`${testId}-empty`}>
        {label}: not recorded
      </span>
    );
  }
  const copy = () => {
    // In a non-secure context `navigator.clipboard` is undefined, so the property access
    // itself throws before any .catch could attach.
    void navigator.clipboard?.writeText(preview.text)?.catch(() => undefined);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      <span className="q-field__hint">
        {label} ({formatBytes(preview.bytes)})
      </span>
      <pre className="q-payload" data-testid={testId}>
        {preview.text}
      </pre>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <Button variant="ghost" type="button"  onClick={copy}>
          Copy
        </Button>
        {preview.truncated ? (
          <span className="q-field__hint">Shown truncated — copy gives you the same slice.</span>
        ) : null}
      </div>
    </div>
  );
}
