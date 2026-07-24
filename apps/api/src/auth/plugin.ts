import { getActiveApiKey, getActiveSession, getMembership, hashToken, listMemberships, type Role } from '@xperiment/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { sendProblem } from '../problem.js';

export interface AuthContext {
  userId: string | null;
  workspaceId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null;
  }
}

const ROLE_ORDER: Record<Role, number> = { viewer: 0, builder: 1, admin: 2, owner: 3 };

export function requireRole(ctx: AuthContext, minimum: Role): boolean {
  return ROLE_ORDER[ctx.role] >= ROLE_ORDER[minimum];
}

/** Sends a 403 problem and returns false when the role is insufficient. */
export function roleGate(reply: FastifyReply, ctx: AuthContext, minimum: Role): boolean {
  if (requireRole(ctx, minimum)) return true;
  sendProblem(reply, 403, 'Forbidden', `Requires ${minimum} role or above`);
  return false;
}

const EXEMPT = new Set(['/v1/healthz', '/v1/openapi.json', '/v1/auth/register', '/v1/auth/login']);

export function registerAuthPlugin(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.decorateRequest('authContext', null);

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    if (EXEMPT.has(path)) return;

    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return sendProblem(reply, 401, 'Unauthorized', 'Bearer token required');
    }
    const token = header.slice('Bearer '.length);

    if (token.startsWith('qs_')) {
      const session = await getActiveSession(deps.pool, hashToken(token));
      if (!session) return sendProblem(reply, 401, 'Unauthorized', 'Invalid or expired session');
      const requestedWorkspace = req.headers['x-xperiment-workspace'] as string | undefined;
      if (requestedWorkspace) {
        const role = await getMembership(deps.pool, requestedWorkspace, session.userId);
        if (!role) return sendProblem(reply, 403, 'Forbidden', 'Not a member of that workspace');
        req.authContext = { userId: session.userId, workspaceId: requestedWorkspace, role };
        return;
      }
      const memberships = await listMemberships(deps.pool, session.userId);
      const first = memberships[0];
      if (!first) return sendProblem(reply, 403, 'Forbidden', 'No workspace membership');
      req.authContext = { userId: session.userId, workspaceId: first.workspaceId, role: first.role };
      return;
    }

    if (token.startsWith('qk_')) {
      const key = await getActiveApiKey(deps.pool, hashToken(token));
      if (!key) return sendProblem(reply, 401, 'Unauthorized', 'Invalid api key');
      req.authContext = { userId: null, workspaceId: key.workspaceId, role: 'builder' };
      return;
    }

    return sendProblem(reply, 401, 'Unauthorized', 'Unrecognized token');
  });
}

/** Non-null accessor for handlers behind the auth plugin. */
export function authOf(req: FastifyRequest): AuthContext {
  if (!req.authContext) throw new Error('authContext missing — route not behind auth plugin');
  return req.authContext;
}
