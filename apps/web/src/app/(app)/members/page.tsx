'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NativeSelect } from '@/components/common/NativeSelect';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/alert';
import { useState } from 'react';
import { PermissionNotice } from '../../../components/common/PermissionNotice';
import { ApiError, getBrowserClient } from '../../../lib/api';
import type { WorkspaceMember } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';
import { forbiddenDetail } from '../../../lib/permissions';

const ROLES = ['viewer', 'operator', 'billing', 'builder', 'admin', 'owner'] as const;

function MemberRow({ member, onError }: { member: WorkspaceMember; onError: (message: string) => void }) {
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: (role: string) => getBrowserClient().updateMemberRole(member.userId, role),
    onSuccess: () => {
      onError('');
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err: unknown) => {
      onError(err instanceof ApiError ? (err.detail ?? err.title) : 'Could not change the role');
      // Snap the select back to the server's value.
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
  });

  return (
    <TableRow data-testid={`member-${member.userId}`}>
      <TableCell>{member.email}</TableCell>
      <TableCell>
        <NativeSelect
          value={member.role}
          disabled={change.isPending}
          onChange={(e) => change.mutate(e.target.value)}
          data-testid={`role-${member.userId}`}
          aria-label={`Role for ${member.email}`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </NativeSelect>
      </TableCell>
      <TableCell style={{ color: 'var(--text-secondary)' }}>{fmtTime(member.createdAt)}</TableCell>
    </TableRow>
  );
}

export default function MembersPage() {
  const [error, setError] = useState('');
  const membersQ = useQuery({ queryKey: ['members'], queryFn: () => getBrowserClient().listMembers(), retry: false });

  const forbidden = forbiddenDetail(membersQ.error);

  return (
    <div data-testid="members-page">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1>Members</h1>
      </div>

      {forbidden ? (
        <PermissionNotice detail={forbidden} />
      ) : (
        <>
          {error ? (
            <Alert className="flex flex-wrap items-center gap-3" data-testid="member-error">
              {error}
            </Alert>
          ) : null}
          {membersQ.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : null}
          {membersQ.isError && !forbidden ? (
            <Alert className="flex flex-wrap items-center gap-3">Could not load members.</Alert>
          ) : null}
          {membersQ.data ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {membersQ.data.items.map((m) => (
                  <MemberRow key={m.userId} member={m} onError={setError} />
                ))}
              </TableBody>
            </Table>
          ) : null}
        </>
      )}
    </div>
  );
}
