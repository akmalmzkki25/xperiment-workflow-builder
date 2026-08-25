'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
      <div className="q-page-head">
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
        <table className="q-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Draft rev</th>
              <th>Id</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((wf) => (
              <tr key={wf.id} data-testid={`wf-row-${wf.name}`}>
                <td>
                  <Link href={`/workflows/${wf.id}`} className="q-table__rowlink">
                    {wf.name}
                  </Link>
                </td>
                <td style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <StatusChip status={wf.status} />
                  {wf.active ? <LiveChip label="Active" /> : null}
                </td>
                <td>{wf.draftRevision}</td>
                <td className="mono" style={{ color: 'var(--text-muted)' }}>
                  {wf.id.slice(0, 8)}
                </td>
                <td>
                  <Button asChild variant="ghost" size="sm"><Link
                    href={`/workflows/${wf.id}/versions`}
                    
                    data-testid={`wf-history-${wf.id.slice(0, 8)}`}>
                    History
                  </Link></Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        title="New workflow"
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        actions={
          <>
            <Button variant="ghost"  onClick={() => setDialogOpen(false)}>
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
        {create.isError ? <div className="q-banner">{(create.error as Error).message}</div> : null}
      </Dialog>
    </>
  );
}
