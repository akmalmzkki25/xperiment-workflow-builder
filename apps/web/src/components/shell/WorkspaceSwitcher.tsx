'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBrowserClient } from '../../lib/api';
import { getWorkspace, setWorkspace } from '../../lib/auth';

export function WorkspaceSwitcher() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['me'], queryFn: () => getBrowserClient().me() });
  if (!data) return null;
  const current = getWorkspace() ?? data.currentWorkspaceId;
  return (
    <select
      className="q-select"
      value={current}
      aria-label="Workspace"
      data-testid="workspace-switcher"
      onChange={(e) => {
        setWorkspace(e.target.value);
        void queryClient.invalidateQueries();
      }}
    >
      {data.workspaces.map((ws) => (
        <option key={ws.id} value={ws.id}>
          {ws.name} · {ws.role}
        </option>
      ))}
    </select>
  );
}
