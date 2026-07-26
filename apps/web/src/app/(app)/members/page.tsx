'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, getBrowserClient } from '../../../lib/api';
import type { WorkspaceMember } from '../../../lib/api';
import { fmtTime } from '../../../lib/format';

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
    <tr data-testid={`member-${member.userId}`}>
      <td>{member.email}</td>
      <td>
        <select
          className="q-select"
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
        </select>
      </td>
      <td style={{ color: 'var(--text-secondary)' }}>{fmtTime(member.createdAt)}</td>
    </tr>
  );
}

export default function MembersPage() {
  const [error, setError] = useState('');
  const membersQ = useQuery({ queryKey: ['members'], queryFn: () => getBrowserClient().listMembers(), retry: false });

  const forbidden = membersQ.error instanceof ApiError && membersQ.error.status === 403;

  return (
    <div data-testid="members-page">
      <div className="q-page-head">
        <h1>Members</h1>
      </div>

      {forbidden ? (
        <p style={{ color: 'var(--text-muted)' }}>You need the member:manage permission to view members.</p>
      ) : (
        <>
          {error ? (
            <div className="q-banner" data-testid="member-error">
              {error}
            </div>
          ) : null}
          {membersQ.isLoading ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : null}
          {membersQ.isError && !forbidden ? (
            <div className="q-banner">Could not load members.</div>
          ) : null}
          {membersQ.data ? (
            <table className="q-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {membersQ.data.items.map((m) => (
                  <MemberRow key={m.userId} member={m} onError={setError} />
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      )}
    </div>
  );
}
