import { clearToken, getToken, getWorkspace } from './auth';

export interface ConnectorItem {
  type: string;
  kind: 'trigger' | 'action' | 'logic';
  operationVersion: string;
  defaultEffectClass: 'pure' | 'read' | 'write';
  outputPorts: string[];
  requiresConnection?: string;
  paramsJsonSchema: unknown;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  activeVersionId: string | null;
  draftRevision: number;
  active: boolean;
}

export interface WorkflowVersionInfo {
  id: string;
  versionNumber: number;
  definitionHash: string;
  publishedAt: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  draft: { definition: unknown; revision: number } | null;
  versions: WorkflowVersionInfo[];
}

export interface Finding {
  layer: 'schema' | 'graph' | 'parameters' | 'expressions' | 'connections';
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
  position?: number;
}

export interface TriggerView {
  nodeId: string;
  type: 'webhook' | 'schedule';
  active: boolean;
  url?: string;
  testUrl?: string;
  authMode?: string | null;
  secret?: string | null;
  cron?: string | null;
  timezone?: string | null;
  nextFireAt?: string | null;
}

export interface ConnectionRow {
  id: string;
  connectorKey: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface ExecutionRow {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  status: string;
  errorSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ExecutionNodeRow {
  nodeId: string;
  status: string;
  attempt: number;
  outputPort: string | null;
  errorJson: unknown;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionEventRow {
  sequence: number;
  eventType: string;
  nodeId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ExecutionWaitRow {
  nodeId: string;
  kind: string;
  status: string;
  expiresAt: string | null;
  decision: string | null;
  resolvedBy: string | null;
  resumeUrl?: string;
}

export interface ExecutionDetail {
  execution: ExecutionRow;
  nodes: ExecutionNodeRow[];
  events: ExecutionEventRow[];
  waits: ExecutionWaitRow[];
}

export interface UsageSummary {
  period: { from: string; to: string };
  totals: { executions: number; succeeded: number; failed: number; nodes: number; computeMs: number; aiTokens: number };
  series: { date: string; executions: number; nodes: number; computeMs: number; aiTokens: number }[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  useCase: string;
  version: string;
  requiredConnectors: string[];
}

export interface WorkflowTemplate extends TemplateSummary {
  definition: { nodes: { id: string; type: string }[]; edges: unknown[] };
}

export interface WorkflowDiff {
  nodes: { added: string[]; removed: string[]; modified: { nodeId: string; changedFields: string[] }[] };
  edges: { added: string[]; removed: string[]; modified: { edgeId: string }[] };
  changed: boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  type: string;
  params: Record<string, unknown>;
  webhookUrl: string | null;
  enabled: boolean;
  cooldownMinutes: number;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  firedAt: string;
  detail: Record<string, unknown>;
  acknowledgedAt: string | null;
}

export interface MeResponse {
  user: { id: string };
  emailVerified: boolean;
  mfaEnabled: boolean;
  currentWorkspaceId: string;
  workspaces: { id: string; name: string; role: string; requireMfa: boolean }[];
}

/**
 * A password alone stops being enough once a second factor is confirmed: the server
 * answers with a challenge to trade for a session, not with the session itself.
 */
export type LoginResult = { token: string; mfaRequired?: undefined } | { mfaRequired: true; challenge: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly title: string,
    public readonly detail?: string,
  ) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApiError';
  }
}

export interface ClientDeps {
  baseUrl: string;
  getToken: () => string | null;
  getWorkspace?: () => string | null;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

async function parseProblem(res: Response): Promise<{ title: string; detail?: string }> {
  try {
    const body = (await res.json()) as { title?: string; detail?: string };
    if (body.title) return { title: body.title, ...(body.detail ? { detail: body.detail } : {}) };
  } catch {
    // fall through to the generic title
  }
  return { title: `HTTP ${res.status}` };
}

export class ApiClient {
  constructor(private readonly deps: ClientDeps) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    const token = this.deps.getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    const workspace = this.deps.getWorkspace?.();
    if (workspace) headers['x-xperiment-workspace'] = workspace;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.deps.baseUrl}${path}`, init);
    if (res.status === 401) this.deps.onUnauthorized?.();
    if (!res.ok) {
      const problem = await parseProblem(res);
      throw new ApiError(res.status, problem.title, problem.detail);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  register(email: string, password: string): Promise<{ token: string }> {
    return this.request('POST', '/v1/auth/register', { body: { email, password } });
  }

  login(email: string, password: string): Promise<LoginResult> {
    return this.request('POST', '/v1/auth/login', { body: { email, password } });
  }

  /** Both enrolment steps re-authenticate: a bearer token alone must not attach a factor. */
  mfaSetup(password: string): Promise<{ secretBase32: string; otpauthUri: string }> {
    return this.request('POST', '/v1/auth/mfa/setup', { body: { password } });
  }

  mfaConfirm(code: string, password: string): Promise<{ recoveryCodes: string[]; remaining: number }> {
    return this.request('POST', '/v1/auth/mfa/confirm', { body: { code, password } });
  }

  mfaDisable(code: string): Promise<{ mfaEnabled: boolean }> {
    return this.request('POST', '/v1/auth/mfa/disable', { body: { code } });
  }

  mfaRecoveryCodes(code: string): Promise<{ recoveryCodes: string[]; remaining: number }> {
    return this.request('POST', '/v1/auth/mfa/recovery-codes', { body: { code } });
  }

  mfaVerify(challenge: string, code: string): Promise<{ token: string; recoveryCodesRemaining: number }> {
    return this.request('POST', '/v1/auth/mfa/verify', { body: { challenge, code } });
  }

  setMfaPolicy(requireMfa: boolean): Promise<{ requireMfa: boolean }> {
    return this.request('PUT', '/v1/workspaces/mfa-policy', { body: { requireMfa } });
  }

  me(): Promise<MeResponse> {
    return this.request('GET', '/v1/auth/me');
  }

  logout(): Promise<void> {
    return this.request('POST', '/v1/auth/logout');
  }

  forgotPassword(email: string): Promise<{ sent: boolean }> {
    return this.request('POST', '/v1/auth/forgot-password', { body: { email } });
  }

  resetPassword(token: string, password: string): Promise<{ reset: boolean }> {
    return this.request('POST', '/v1/auth/reset-password', { body: { token, password } });
  }

  verifyEmail(token: string): Promise<{ verified: boolean }> {
    return this.request('POST', '/v1/auth/verify-email', { body: { token } });
  }

  resendVerification(): Promise<{ verified: boolean }> {
    return this.request('POST', '/v1/auth/resend-verification');
  }

  listConnectors(): Promise<{ items: ConnectorItem[] }> {
    return this.request('GET', '/v1/connectors');
  }

  listWorkflows(): Promise<{ items: WorkflowSummary[]; nextCursor: string | null }> {
    return this.request('GET', '/v1/workflows');
  }

  createWorkflow(name: string): Promise<WorkflowSummary> {
    return this.request('POST', '/v1/workflows', { body: { name } });
  }

  getWorkflow(id: string): Promise<WorkflowDetail> {
    return this.request('GET', `/v1/workflows/${id}`);
  }

  putDraft(id: string, definition: unknown, revision: number): Promise<{ revision: number }> {
    return this.request('PUT', `/v1/workflows/${id}/draft`, {
      body: { definition },
      headers: { 'if-match': String(revision) },
    });
  }

  validate(id: string): Promise<{ valid: boolean; findings: Finding[] }> {
    return this.request('POST', `/v1/workflows/${id}/validate`);
  }

  publish(id: string): Promise<{ id: string; versionNumber: number; definitionHash: string }> {
    return this.request('POST', `/v1/workflows/${id}/publish`);
  }

  activate(id: string): Promise<{ active: true; triggers: TriggerView[] }> {
    return this.request('POST', `/v1/workflows/${id}/activate`);
  }

  deactivate(id: string): Promise<{ active: false }> {
    return this.request('POST', `/v1/workflows/${id}/deactivate`);
  }

  listTriggers(id: string): Promise<{ triggers: TriggerView[] }> {
    return this.request('GET', `/v1/workflows/${id}/triggers`);
  }

  execute(id: string): Promise<{ executionId: string; status: string; created: boolean }> {
    return this.request('POST', `/v1/workflows/${id}/execute`);
  }

  listConnections(): Promise<{ items: ConnectionRow[] }> {
    return this.request('GET', '/v1/connections');
  }

  createConnection(connectorKey: string, name: string, payload: unknown): Promise<ConnectionRow> {
    return this.request('POST', '/v1/connections', { body: { connectorKey, name, payload } });
  }

  deleteConnection(id: string): Promise<void> {
    return this.request('DELETE', `/v1/connections/${id}`);
  }

  testConnection(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.request('POST', `/v1/connections/${id}/test`);
  }

  listExecutions(q?: {
    workflowId?: string;
    limit?: number;
  }): Promise<{ items: ExecutionRow[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (q?.workflowId) params.set('workflowId', q.workflowId);
    if (q?.limit) params.set('limit', String(q.limit));
    const qs = params.toString();
    return this.request('GET', `/v1/executions${qs ? `?${qs}` : ''}`);
  }

  getExecution(id: string): Promise<ExecutionDetail> {
    return this.request('GET', `/v1/executions/${id}`);
  }

  cancelExecution(id: string): Promise<{ status: string }> {
    return this.request('POST', `/v1/executions/${id}/cancel`);
  }

  retryExecution(id: string): Promise<{ executionId: string; created: boolean }> {
    return this.request('POST', `/v1/executions/${id}/retry`);
  }

  listTemplates(category?: string): Promise<{ items: TemplateSummary[] }> {
    return this.request('GET', `/v1/templates${category ? `?category=${encodeURIComponent(category)}` : ''}`);
  }

  getTemplate(id: string): Promise<WorkflowTemplate> {
    return this.request('GET', `/v1/templates/${id}`);
  }

  cloneTemplate(id: string, name?: string): Promise<{ id: string; name: string }> {
    return this.request('POST', `/v1/templates/${id}/clone`, name ? { body: { name } } : {});
  }

  getDiff(id: string, from: string, to: string): Promise<{ from: string; to: string; diff: WorkflowDiff }> {
    const qs = new URLSearchParams({ from, to }).toString();
    return this.request('GET', `/v1/workflows/${id}/diff?${qs}`);
  }

  rollbackVersion(id: string, versionId: string): Promise<{ id: string; versionNumber: number; rolledBackFrom: number }> {
    return this.request('POST', `/v1/workflows/${id}/versions/${versionId}/rollback`);
  }

  listAlerts(): Promise<{ items: AlertRule[] }> {
    return this.request('GET', '/v1/alerts');
  }

  createAlert(body: {
    name: string;
    type: string;
    params: Record<string, unknown>;
    webhookUrl?: string;
    cooldownMinutes?: number;
  }): Promise<AlertRule & { secret?: string }> {
    return this.request('POST', '/v1/alerts', { body });
  }

  updateAlert(
    id: string,
    body: { name?: string; enabled?: boolean; cooldownMinutes?: number; params?: Record<string, unknown> },
  ): Promise<AlertRule> {
    return this.request('PUT', `/v1/alerts/${id}`, { body });
  }

  deleteAlert(id: string): Promise<void> {
    return this.request('DELETE', `/v1/alerts/${id}`);
  }

  listAlertEvents(): Promise<{ items: AlertEvent[]; unacknowledged: number }> {
    return this.request('GET', '/v1/alerts/events');
  }

  acknowledgeAlert(id: string): Promise<{ acknowledged: boolean }> {
    return this.request('POST', `/v1/alerts/events/${id}/ack`);
  }

  getUsage(params?: { from?: string; to?: string }): Promise<UsageSummary> {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    const s = qs.toString();
    return this.request('GET', `/v1/usage${s ? `?${s}` : ''}`);
  }

  aiGenerate(prompt: string): Promise<{ ir: unknown; attempts: number }> {
    return this.request('POST', '/v1/ai/generate', { body: { prompt } });
  }

  aiEdit(prompt: string, definition: unknown): Promise<{ ir: unknown; attempts: number }> {
    return this.request('POST', '/v1/ai/edit', { body: { prompt, definition } });
  }

  listApprovals(): Promise<{ items: ApprovalItem[] }> {
    return this.request('GET', '/v1/approvals');
  }

  decideApproval(
    executionId: string,
    nodeId: string,
    decision: 'approve' | 'reject',
    comment?: string,
  ): Promise<{ resolved: boolean }> {
    return this.request('POST', `/v1/executions/${executionId}/approvals/${nodeId}`, {
      body: { decision, ...(comment ? { comment } : {}) },
    });
  }

  listMembers(): Promise<{ items: WorkspaceMember[] }> {
    return this.request('GET', '/v1/workspaces/members');
  }

  listAudit(params: { limit?: number; before?: string; action?: string } = {}): Promise<AuditPage> {
    const q = new URLSearchParams();
    if (params.limit !== undefined) q.set('limit', String(params.limit));
    if (params.before) q.set('before', params.before);
    if (params.action) q.set('action', params.action);
    const qs = q.toString();
    return this.request('GET', `/v1/audit${qs ? `?${qs}` : ''}`);
  }

  updateMemberRole(userId: string, role: string): Promise<{ userId: string; role: string }> {
    return this.request('PUT', `/v1/workspaces/members/${userId}`, { body: { role } });
  }

  getPlan(): Promise<PlanSnapshot> {
    return this.request('GET', '/v1/plan');
  }

  updatePlan(patch: { planCode?: string; allowOverage?: boolean }): Promise<PlanSnapshot> {
    return this.request('PUT', '/v1/plan', { body: patch });
  }

  listInvoices(): Promise<{ items: InvoiceSummary[] }> {
    return this.request('GET', '/v1/invoices');
  }

  markInvoicePaid(id: string): Promise<{ status: string }> {
    return this.request('POST', `/v1/invoices/${id}/mark-paid`);
  }
}

export interface InvoiceSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  planCode: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  status: 'issued' | 'paid' | 'void';
}

export type QuotaMetric = 'executionsPerMonth' | 'aiTokensPerMonth' | 'activeWorkflows' | 'members';

export interface QuotaLineView {
  metric: QuotaMetric;
  used: number;
  /** null means unlimited. */
  limit: number | null;
  status: 'ok' | 'warn' | 'blocked';
}

export interface PlanSnapshot {
  planCode: string;
  allowOverage: boolean;
  limits: Record<QuotaMetric, number | null>;
  usage: Record<QuotaMetric, number>;
  lines: QuotaLineView[];
  period: { start: string; end: string };
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface AuditEvent {
  /** BIGSERIAL: arrives as a string, and doubles as the page cursor. */
  id: string;
  actorKind: 'user' | 'api_key' | 'system' | 'anonymous';
  actorEmail: string | null;
  actorApiKeyName: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure';
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEvent[];
  nextBefore: string | null;
}

export interface ApprovalItem {
  waitId: string;
  executionId: string;
  workflowId: string;
  nodeId: string;
  message: string | null;
  expiresAt: string | null;
  createdAt: string;
}

let browserClient: ApiClient | null = null;

export function getBrowserClient(): ApiClient {
  browserClient ??= new ApiClient({
    baseUrl: process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000',
    getToken,
    getWorkspace,
    onUnauthorized: () => {
      clearToken();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    },
  });
  return browserClient;
}
