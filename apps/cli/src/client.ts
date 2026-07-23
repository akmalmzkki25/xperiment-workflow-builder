export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: unknown,
  ) {
    super(`API error ${status}`);
    this.name = 'ApiError';
  }
}

export interface ExecutionDetail {
  execution: { id: string; status: string; errorSummary: string | null };
  nodes: {
    nodeId: string;
    status: string;
    attempt: number;
    outputPort: string | null;
    errorJson: unknown;
    startedAt: string | null;
    completedAt: string | null;
  }[];
  events: { sequence: number; eventType: string; nodeId: string | null; createdAt: string }[];
}

export class ApiClient {
  constructor(private readonly baseUrl: string = process.env['XPERIMENT_API_URL'] ?? 'http://localhost:3000') {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  createWorkflow(name: string): Promise<{ id: string; name: string; draftRevision: number }> {
    return this.request('POST', '/v1/workflows', { name });
  }
  getWorkflow(id: string): Promise<{ id: string; name: string; status: string; draft: unknown; versions: unknown[] }> {
    return this.request('GET', `/v1/workflows/${id}`);
  }
  listWorkflows(): Promise<{ items: { id: string; name: string; status: string }[]; nextCursor: string | null }> {
    return this.request('GET', '/v1/workflows');
  }
  updateDraft(id: string, definition: unknown, revision: number): Promise<{ revision: number }> {
    return this.request('PUT', `/v1/workflows/${id}/draft`, { definition }, { 'if-match': String(revision) });
  }
  validate(id: string): Promise<{ valid: boolean; findings: unknown[] }> {
    return this.request('POST', `/v1/workflows/${id}/validate`);
  }
  publish(id: string): Promise<{ id: string; versionNumber: number; definitionHash: string }> {
    return this.request('POST', `/v1/workflows/${id}/publish`);
  }
  execute(
    id: string,
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<{ executionId: string; status: string; created: boolean }> {
    return this.request(
      'POST',
      `/v1/workflows/${id}/execute`,
      payload,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined,
    );
  }
  getExecution(id: string): Promise<ExecutionDetail> {
    return this.request('GET', `/v1/executions/${id}`);
  }
}
