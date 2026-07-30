import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

export interface AuthedUser {
  token: string;
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
  /** app.inject with the Authorization header merged in. */
  inject: (opts: InjectOptions) => Promise<InjectResponse>;
}

export async function createAuthedUser(app: FastifyInstance): Promise<AuthedUser> {
  const email = `u-${randomUUID()}@xperiment.test`;
  const password = 'password-123';
  const r = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } });
  if (r.statusCode !== 201) throw new Error(`register failed: ${r.body}`);
  const body = r.json<{ token: string; user: { id: string }; workspace: { id: string } }>();
  return {
    token: body.token,
    email,
    password,
    userId: body.user.id,
    workspaceId: body.workspace.id,
    inject: (opts: InjectOptions) =>
      app.inject({
        ...opts,
        headers: { authorization: `Bearer ${body.token}`, ...(opts.headers ?? {}) },
      } as InjectOptions) as Promise<InjectResponse>,
  };
}

/**
 * Issues an api key in `owner`'s workspace and returns an inject bound to it. The
 * resulting requests authenticate as an api key rather than a session, so
 * `AuthContext.apiKeyId` is populated and audit rows name the key as the actor.
 */
export async function createApiKeyClient(
  app: FastifyInstance,
  owner: AuthedUser,
  role?: string,
): Promise<{ id: string; token: string; inject: (opts: InjectOptions) => Promise<InjectResponse> }> {
  const r = await owner.inject({
    method: 'POST',
    url: '/v1/api-keys',
    payload: { name: `k-${randomUUID().slice(0, 8)}`, ...(role ? { role } : {}) },
  });
  if (r.statusCode !== 201) throw new Error(`api key issue failed: ${r.body}`);
  const body = r.json<{ id: string; key: string }>();
  return {
    id: body.id,
    token: body.key,
    inject: (opts: InjectOptions) =>
      app.inject({
        ...opts,
        headers: { authorization: `Bearer ${body.key}`, ...(opts.headers ?? {}) },
      } as InjectOptions) as Promise<InjectResponse>,
  };
}

/**
 * Registers a fresh user and adds them to `workspaceId` with `role`, returning an
 * inject bound to that workspace (via X-Xperiment-Workspace) so the request's auth
 * context carries the requested role.
 */
export async function addMemberWithRole(
  app: FastifyInstance,
  pool: import('pg').Pool,
  workspaceId: string,
  role: string,
): Promise<AuthedUser> {
  const user = await createAuthedUser(app);
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, user.userId, role],
  );
  return {
    ...user,
    workspaceId,
    inject: (opts: InjectOptions) =>
      app.inject({
        ...opts,
        headers: {
          authorization: `Bearer ${user.token}`,
          'x-xperiment-workspace': workspaceId,
          ...(opts.headers ?? {}),
        },
      } as InjectOptions) as Promise<InjectResponse>,
  };
}
