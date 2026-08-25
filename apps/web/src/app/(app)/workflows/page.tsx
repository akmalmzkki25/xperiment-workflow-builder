'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LiveChip, StatusChip } from '../../../components/common/StatusChip';
import { ImportButton } from '../../../components/workflows/ImportButton';
import { Dialog } from '../../../components/common/Dialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { TextField } from '../../../components/common/TextField';
import { getBrowserClient } from '../../../lib/api';
import { forbiddenDetail } from '../../../lib/permissions';

export default function WorkflowsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');

  const workflows = useQuery({
    queryKey: ['workflows'],
    queryFn: () => getBrowserClient().listWorkflows(),
    retry: false,
  });
  const forbidden = forbiddenDetail(workflows.error);
  const create = useMutation({
    mutationFn: (workflowName: string) => getBrowserClient().createWorkflow(workflowName),
    onSuccess: (wf) => {
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      router.push(`/workflows/${wf.id}`);
    },
  });

  const items = workflows.data?.items ?? [];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>Workflows</h1>
        {forbidden ? null : (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <ImportButton onImported={() => void queryClient.invalidateQueries({ queryKey: ['workflows'] })} />
            <Button  data-testid="wf-create" onClick={() => setDialogOpen(true)}>
              New workflow
            </Button>
          </div>
        )}
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : workflows.isLoading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading workflows…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          hint="Create your first workflow and wire a trigger to an action on the canvas."
          action={
            <Button  data-testid="wf-create-empty" onClick={() => setDialogOpen(true)}>
              New workflow
            </Button>
          }
        />
      ) : (
        <Table data-testid="wf-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Draft rev</TableHead>
              <TableHead>Id</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((wf) => (
              <TableRow key={wf.id} data-testid={`wf-row-${wf.name}`}>
                <TableCell>
                  <Link href={`/workflows/${wf.id}`} className="font-semibold text-inherit">
                    {wf.name}
                  </Link>
                </TableCell>
                <TableCell style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <StatusChip status={wf.status} />
                  {wf.active ? <LiveChip label="Active" /> : null}
                </TableCell>
                <TableCell>{wf.draftRevision}</TableCell>
                <TableCell className="mono" style={{ color: 'var(--text-muted)' }}>
                  {wf.id.slice(0, 8)}
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm"><Link
                    href={`/workflows/${wf.id}/versions`}
                    
                    data-testid={`wf-history-${wf.id.slice(0, 8)}`}>
                    History
                  </Link></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        title="New workflow"
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="wf-create-submit"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate(name.trim())}
            >
              Create
            </Button>
          </>
        }
      >
        <TextField label="Name" value={name} onChange={setName} placeholder="Lead check" testId="wf-name-input" />
        {create.isError ? <Alert className="flex flex-wrap items-center gap-3">{(create.error as Error).message}</Alert> : null}
      </Dialog>
    </>
  );
}
