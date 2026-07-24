const TOKEN_KEY = 'xperiment.token';
const WORKSPACE_KEY = 'xperiment.workspace';

function storage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function getToken(): string | null {
  return storage()?.getItem(TOKEN_KEY) ?? null;
}

export function setToken(token: string): void {
  storage()?.setItem(TOKEN_KEY, token);
}

export function getWorkspace(): string | null {
  return storage()?.getItem(WORKSPACE_KEY) ?? null;
}

export function setWorkspace(workspaceId: string): void {
  storage()?.setItem(WORKSPACE_KEY, workspaceId);
}

export function clearToken(): void {
  storage()?.removeItem(TOKEN_KEY);
  storage()?.removeItem(WORKSPACE_KEY);
}
