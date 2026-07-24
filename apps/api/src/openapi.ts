/** Hand-authored OpenAPI 3.1 document for the /v1 public surface. */
export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Xperiment Workflow API',
    version: '0.1.0',
    description: 'REST API for building, running, and monitoring Xperiment workflows.',
  },
  servers: [{ url: '/', description: 'This instance' }],
  components: {
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'A session token (qs_…) or an API key (qk_…). Send an X-Xperiment-Workspace header to select a workspace when using a session token.',
      },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/v1/auth/register': { post: { summary: 'Register a user and workspace', security: [], tags: ['auth'] } },
    '/v1/auth/login': { post: { summary: 'Log in', security: [], tags: ['auth'] } },
    '/v1/auth/me': { get: { summary: 'Current user + workspaces', tags: ['auth'] } },
    '/v1/workflows': {
      get: { summary: 'List workflows (cursor paginated)', tags: ['workflows'] },
      post: { summary: 'Create a workflow', tags: ['workflows'] },
    },
    '/v1/workflows/{id}': { get: { summary: 'Get a workflow with its draft + versions', tags: ['workflows'] } },
    '/v1/workflows/{id}/draft': { put: { summary: 'Update the draft (If-Match revision)', tags: ['workflows'] } },
    '/v1/workflows/{id}/validate': { post: { summary: 'Validate the draft', tags: ['workflows'] } },
    '/v1/workflows/{id}/publish': { post: { summary: 'Publish a version', tags: ['workflows'] } },
    '/v1/workflows/{id}/activate': { post: { summary: 'Activate triggers', tags: ['workflows'] } },
    '/v1/workflows/{id}/deactivate': { post: { summary: 'Deactivate triggers', tags: ['workflows'] } },
    '/v1/workflows/{id}/execute': { post: { summary: 'Execute (Idempotency-Key supported)', tags: ['executions'] } },
    '/v1/workflows/{id}/callback': {
      put: { summary: 'Set the completion webhook (returns the signing secret once)', tags: ['workflows'] },
      delete: { summary: 'Clear the completion webhook', tags: ['workflows'] },
    },
    '/v1/executions': { get: { summary: 'List executions (cursor paginated)', tags: ['executions'] } },
    '/v1/executions/{id}': { get: { summary: 'Get an execution timeline', tags: ['executions'] } },
    '/v1/executions/{id}/retry': { post: { summary: 'Replay as a new execution', tags: ['executions'] } },
    '/v1/executions/{id}/cancel': { post: { summary: 'Cancel a running execution', tags: ['executions'] } },
    '/v1/executions/{id}/approvals/{nodeId}': { post: { summary: 'Approve or reject a pending approval', tags: ['approvals'] } },
    '/v1/approvals': { get: { summary: 'List pending approvals', tags: ['approvals'] } },
    '/v1/usage': { get: { summary: 'Usage totals + daily series (from/to, default current month)', tags: ['usage'] } },
    '/v1/connectors': { get: { summary: 'Connector catalog with param JSON Schemas', tags: ['connectors'] } },
    '/v1/connections': {
      get: { summary: 'List connections', tags: ['connections'] },
      post: { summary: 'Create a connection (secrets encrypted at rest)', tags: ['connections'] },
    },
    '/v1/connections/{id}': { delete: { summary: 'Delete a connection', tags: ['connections'] } },
    '/v1/connections/{id}/test': { post: { summary: 'Test a connection', tags: ['connections'] } },
    '/v1/ai/generate': { post: { summary: 'Generate a workflow from a prompt', tags: ['ai'] } },
    '/v1/ai/edit': { post: { summary: 'Edit a workflow from a prompt', tags: ['ai'] } },
  },
} as const;
