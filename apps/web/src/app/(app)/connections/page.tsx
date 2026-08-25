'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { ConnectionDialog, type RotateTarget } from '../../../components/connections/ConnectionDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { getBrowserClient } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

type TestResult = { ok: boolean; error?: string };

export default function ConnectionsPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [rotating, setRotating] = useState<RotateTarget | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [pageError, setPageError] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => getBrowserClient().listConnections(),
    retry: false,
  });
  // connection:read is builder-and-up: a viewer/operator/billing member must be told
  // they may not enumerate connections, not shown a false "none exist" empty state.
  const forbidden = forbiddenDetail(connections.error);

  const test = useMutation({
    mutationFn: async (id: string) => ({ id, result: await getBrowserClient().testConnection(id) }),
    onSuccess: ({ id, result }) => setTestResults((prev) => ({ ...prev, [id]: result })),
    // Without this the button did nothing visible on a 4xx: the request throws, onSuccess
    // never fires, and the health column stays on the em dash it started with. A user
    // reads that as "nothing happened" and clicks again.
    onError: (e) => setPageError(e instanceof Error ? e.message : 'Connection test failed'),
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
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>Connections</h1>
        {forbidden ? null : (
          <Button  data-testid="conn-create" onClick={() => setDialogOpen(true)}>
            New connection
          </Button>
        )}
      </div>

      {pageError ? (
        <Alert className="flex flex-wrap items-center gap-3">
          <span>{pageError}</span>
          <Button variant="ghost" size="sm" onClick={() => setPageError(null)}>
            Dismiss
          </Button>
        </Alert>
      ) : null}

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : connections.isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading connections…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No connections yet"
          hint="Store provider credentials once, encrypted, and reference them from workflow nodes."
          action={
            <Button  onClick={() => setDialogOpen(true)}>
              New connection
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Connector</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Health</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((conn) => {
              const result = testResults[conn.id];
              return (
                <TableRow key={conn.id} data-testid={`conn-row-${conn.name}`}>
                  <TableCell style={{ fontWeight: 600 }}>{conn.name}</TableCell>
                  <TableCell>
                    <Badge variant="tone" style={{ color: 'var(--color-tide)' }}>
                      {conn.connectorKey}
                    </Badge>
                  </TableCell>
                  <TableCell style={{ color: 'var(--text-secondary)' }}>{fmtTime(conn.createdAt)}</TableCell>
                  <TableCell>
                    {result ? (
                      <Badge
                        variant="tone"
                        style={{ color: result.ok ? 'var(--status-succeeded)' : 'var(--status-failed)' }}
                        data-testid={`conn-status-${conn.name}`}
                      >
                        {result.ok ? '✓ ok' : `✕ ${result.error ?? 'failed'}`}
                      </Badge>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </TableCell>
                  <TableCell style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                    <Button variant="ghost" size="sm"
                      
                      disabled={test.isPending}
                      onClick={() => test.mutate(conn.id)}
                      data-testid={`conn-test-${conn.name}`}
                    >
                      Test
                    </Button>
                    <Button variant="ghost" size="sm"
                      
                      onClick={() =>
                        setRotating({ id: conn.id, name: conn.name, connectorKey: conn.connectorKey })
                      }
                      data-testid={`conn-rotate-${conn.name}`}
                    >
                      Rotate
                    </Button>
                    <Button variant="destructive" size="sm"
                      
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Delete connection "${conn.name}"?`)) remove.mutate(conn.id);
                      }}
                      data-testid={`conn-delete-${conn.name}`}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConnectionDialog
        open={rotating !== null}
        onClose={() => setRotating(null)}
        rotate={rotating ?? undefined}
      />
    </>
  );
}
