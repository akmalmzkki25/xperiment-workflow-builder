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
