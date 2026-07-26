'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConnectionDialog } from '../../../components/connections/ConnectionDialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { ApiError, getBrowserClient } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';

type TestResult = { ok: boolean; error?: string };

export default function ConnectionsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [pageError, setPageError] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => getBrowserClient().listConnections(),
    retry: false,
  });
  // connection:read is builder-and-up: a viewer/operator/billing member must be told
  // they may not enumerate connections, not shown a false "none exist" empty state.
  const forbidden = connections.error instanceof ApiError && connections.error.status === 403;

  const test = useMutation({
    mutationFn: async (id: string) => ({ id, result: await getBrowserClient().testConnection(id) }),
    onSuccess: ({ id, result }) => setTestResults((prev) => ({ ...prev, [id]: result })),
  });

  const remove = useMutation({
    mutationFn: (id: string) => getBrowserClient().deleteConnection(id),
    onSuccess: () => {
      setPageError(null);
      void queryClient.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (e) => setPageError(e instanceof Error ? e.message : 'Delete failed'),
  });

  const items = connections.data?.items ?? [];

  return (
    <>
      <div className="q-page-head">
        <h1>Connections</h1>
        {forbidden ? null : (
          <button className="q-btn" data-testid="conn-create" onClick={() => setDialogOpen(true)}>
            New connection
          </button>
        )}
      </div>

      {pageError ? (
        <div className="q-banner">
          <span>{pageError}</span>
          <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => setPageError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {forbidden ? (
        <p style={{ color: 'var(--text-muted)' }} data-testid="conn-forbidden">
          You need the connection:read permission to view connections.
        </p>
      ) : connections.isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading connections…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No connections yet"
          hint="Store provider credentials once, encrypted, and reference them from workflow nodes."
          action={
            <button className="q-btn" onClick={() => setDialogOpen(true)}>
              New connection
            </button>
          }
        />
      ) : (
        <table className="q-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Connector</th>
              <th>Created</th>
              <th>Health</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((conn) => {
              const result = testResults[conn.id];
              return (
                <tr key={conn.id} data-testid={`conn-row-${conn.name}`}>
                  <td style={{ fontWeight: 600 }}>{conn.name}</td>
                  <td>
                    <span className="q-chip" style={{ color: 'var(--color-tide)' }}>
                      {conn.connectorKey}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(conn.createdAt)}</td>
                  <td>
                    {result ? (
                      <span
                        className="q-chip"
                        style={{ color: result.ok ? 'var(--status-succeeded)' : 'var(--status-failed)' }}
                        data-testid={`conn-status-${conn.name}`}
                      >
                        {result.ok ? '✓ ok' : `✕ ${result.error ?? 'failed'}`}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                    <button
                      className="q-btn q-btn--ghost q-btn--sm"
                      disabled={test.isPending}
                      onClick={() => test.mutate(conn.id)}
                      data-testid={`conn-test-${conn.name}`}
                    >
                      Test
                    </button>
                    <button
                      className="q-btn q-btn--danger q-btn--sm"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete connection "${conn.name}"?`)) remove.mutate(conn.id);
                      }}
                      data-testid={`conn-delete-${conn.name}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
