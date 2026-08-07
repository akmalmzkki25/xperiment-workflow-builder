import {
  getActiveApiKey,
  getActiveSession,
  getMembership,
  hasConfirmedMfa,
  hashToken,
  listMemberships,
  type AuditActor,
  type Role,
} from '@xperiment/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { sendProblem } from '../problem.js';
import { hasPermission, type Permission } from './permissions.js';

export interface AuthContext {
  userId: string | null;
  /** Which api key authenticated, when one did. Needed to name an audit actor. */
  apiKeyId: string | null;
  workspaceId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null;
  }
}

/**
 * Sends a 403 problem and returns false when the caller's role lacks the
 * permission. Names the permission rather than a role so the message stays
 * true as the role→permission map evolves.
 */
export function requirePermission(reply: FastifyReply, ctx: AuthContext, permission: Permission): boolean {
  if (hasPermission(ctx.role, permission)) return true;
  sendProblem(reply, 403, 'Forbidden', `Requires the '${permission}' permission`);
  return false;
}

const EXEMPT = new Set([
  '/v1/healthz',
  '/v1/openapi.json',
  '/v1/auth/register',
  '/v1/auth/login',
  // AUTH-002 recovery. Someone who has forgotten their password has no session to
  // present, so these must be reachable unauthenticated or the flow is dead — the same
  // trap the payments webhook fell into in 3O.
  '/v1/auth/verify-email',
  // A caller partway through login holds a challenge, not a session, so this must be
  // reachable unauthenticated or the second step is a dead route.
  '/v1/auth/mfa/verify',
  '/v1/auth/forgot-password',
  '/v1/auth/reset-password',
]);

/**
 * Parameterised public paths. A payment provider's callback carries no bearer token —
 * its signature is the credential, verified inside the route — so bouncing it here would
 * make the route unreachable by the only caller it exists for.
 */
const EXEMPT_PATTERNS = [/^\/v1\/payments\/[^/]+\/webhook$/];

/**
 * Routes that stay reachable while a workspace's MFA policy is unmet. This is a SEPARATE
 * list from EXEMPT: EXEMPT decides who needs a session at all, this decides which
 * authenticated routes survive an unmet policy. Without it the policy makes the workspace
 * permanently unusable — the dead-route trap from 3O and AUTH-002.
 */
const MFA_FIX_PATHS = new Set(['/v1/auth/me', '/v1/auth/logout']);
const MFA_FIX_PREFIX = '/v1/auth/mfa/';
const PRIVILEGED: ReadonlySet<Role> = new Set<Role>(['owner', 'admin']);

async function mfaPolicyBlocks(
  pool: pg.Pool,
  path: string,
  ctx: AuthContext,
  requireMfa: boolean,
): Promise<boolean> {
  if (!requireMfa || !ctx.userId || !PRIVILEGED.has(ctx.role)) return false;
  if (MFA_FIX_PATHS.has(path) || path.startsWith(MFA_FIX_PREFIX)) return false;
  return !(await hasConfirmedMfa(pool, ctx.userId));
}

export function registerAuthPlugin(app: FastifyInstance, deps: { pool: pg.Pool }): void {
  app.decorateRequest('authContext', null);

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    if (EXEMPT.has(path) || EXEMPT_PATTERNS.some((p) => p.test(path))) return;

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
        const membership = await getMembership(deps.pool, requestedWorkspace, session.userId);
        if (!membership) return sendProblem(reply, 403, 'Forbidden', 'Not a member of that workspace');
        const explicit: AuthContext = {
          userId: session.userId,
          apiKeyId: null,
          // The canonical id from the database, never the raw header. Postgres matches a
          // uuid parameter case-insensitively, so an upper-case header reaches the same row
          // — but the header string would then become the AES-GCM AAD on every secret this
          // request seals, and nothing could ever open it again with the canonical id.
          workspaceId: membership.workspaceId,
          role: membership.role,
        };
        if (await mfaPolicyBlocks(deps.pool, path, explicit, membership.requireMfa)) {
          return sendProblem(reply, 403, 'MFA required', 'This workspace requires a second factor for your role');
        }
        req.authContext = explicit;
        return;
      }
      const memberships = await listMemberships(deps.pool, session.userId);
      const first = memberships[0];
      if (!first) return sendProblem(reply, 403, 'Forbidden', 'No workspace membership');
      const ctx: AuthContext = {
        userId: session.userId,
        apiKeyId: null,
        workspaceId: first.workspaceId,
        role: first.role,
      };
      if (await mfaPolicyBlocks(deps.pool, path, ctx, first.requireMfa)) {
        return sendProblem(reply, 403, 'MFA required', 'This workspace requires a second factor for your role');
      }
      req.authContext = ctx;
      return;
    }

    if (token.startsWith('qk_')) {
      const key = await getActiveApiKey(deps.pool, hashToken(token));
      if (!key) return sendProblem(reply, 401, 'Unauthorized', 'Invalid api key');
      req.authContext = { userId: null, apiKeyId: key.id, workspaceId: key.workspaceId, role: key.role };
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

/**
 * The audit actor for the current request, in the exact field names AuditEventInput
 * accepts so it spreads directly. Kept here so no route re-derives it and gets the
 * user-versus-api-key distinction subtly wrong.
 */
export function auditActor(req: FastifyRequest): AuditActor {
  const ctx = authOf(req);
  return {
    actorKind: ctx.apiKeyId ? 'api_key' : 'user',
    actorUserId: ctx.userId,
    actorApiKeyId: ctx.apiKeyId,
    requestId: req.id,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}
