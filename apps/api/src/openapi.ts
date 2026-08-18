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
    '/v1/auth/logout': { post: { summary: 'Revoke the current session', tags: ['auth'] } },
    '/v1/auth/logout-all': { post: { summary: 'Revoke every session for this user', tags: ['auth'] } },
    '/v1/auth/forgot-password': {
      post: {
        summary: 'Request a password reset link (always 200, so it cannot enumerate accounts)',
        security: [],
        tags: ['auth'],
      },
    },
    '/v1/auth/reset-password': {
      post: { summary: 'Consume a reset token and revoke every session', security: [], tags: ['auth'] },
    },
    '/v1/auth/verify-email': { post: { summary: 'Confirm an email address', security: [], tags: ['auth'] } },
    '/v1/auth/resend-verification': { post: { summary: 'Send the confirmation email again', tags: ['auth'] } },
    '/v1/auth/mfa/setup': {
      post: { summary: 'Begin TOTP enrolment (returns a secret and otpauth URI)', tags: ['auth'] },
    },
    '/v1/auth/mfa/confirm': { post: { summary: 'Confirm enrolment with a code', tags: ['auth'] } },
    '/v1/auth/mfa/disable': { post: { summary: 'Turn off the second factor', tags: ['auth'] } },
    '/v1/auth/mfa/recovery-codes': { post: { summary: 'Replace the recovery codes', tags: ['auth'] } },
    '/v1/auth/mfa/verify': {
      post: {
        summary: 'Complete a two-step login with a TOTP or recovery code',
        security: [],
        tags: ['auth'],
      },
    },
    '/v1/workspaces': {
      get: { summary: 'Workspaces this caller belongs to', tags: ['workspaces'] },
      post: { summary: 'Create a workspace (caller becomes owner)', tags: ['workspaces'] },
    },
    '/v1/workspaces/invites': { post: { summary: 'Invite someone by email', tags: ['workspaces'] } },
    '/v1/workspaces/mfa-policy': {
      put: { summary: 'Require a second factor for every member', tags: ['workspaces'] },
    },
    '/v1/invites/accept': { post: { summary: 'Accept an invite token', tags: ['workspaces'] } },
    '/v1/api-keys': {
      get: { summary: 'List API keys (metadata only; the key itself is shown once)', tags: ['api-keys'] },
      post: { summary: 'Create an API key', tags: ['api-keys'] },
    },
    '/v1/api-keys/{id}': { delete: { summary: 'Revoke an API key', tags: ['api-keys'] } },
    '/v1/workflows/{id}/triggers': {
      get: {
        summary: 'Trigger URLs and signing secrets (audited: each read is a secret disclosure)',
        tags: ['triggers'],
      },
    },
    '/v1/workflows/{id}/triggers/{nodeId}/samples': {
      get: { summary: 'Recent test-mode payloads for a webhook trigger', tags: ['triggers'] },
    },
    '/v1/workflows/{id}/deliveries': {
      get: {
        summary: 'Recent inbound webhook deliveries, accepted and rejected (no bodies, no header values)',
        tags: ['triggers'],
      },
    },
    '/v1/audit': { get: { summary: 'Audit events for this workspace (cursor paginated)', tags: ['audit'] } },
    '/v1/executions/{id}/nodes/{nodeId}/{attempt}/payload': {
      get: {
        summary: "One node attempt's input and output, redacted (needs execution:run, not just read)",
        tags: ['executions'],
      },
    },
    '/v1/healthz': { get: { summary: 'Liveness: the process is up', security: [], tags: ['ops'] } },
    '/v1/readyz': {
      get: { summary: 'Readiness: dependencies answered (503 when a critical one did not)', security: [], tags: ['ops'] },
    },
    '/v1/workflows': {
      get: { summary: 'List workflows (cursor paginated)', tags: ['workflows'] },
      post: { summary: 'Create a workflow', tags: ['workflows'] },
    },
    '/v1/workflows/{id}': { get: { summary: 'Get a workflow with its draft + versions', tags: ['workflows'] } },
    '/v1/workflows/{id}/draft': { put: { summary: 'Update the draft (If-Match revision)', tags: ['workflows'] } },
    '/v1/workflows/{id}/export': {
      get: {
        summary: 'Download a workflow as a portable document (?version= for a published one; carries no secrets)',
        tags: ['workflows'],
      },
    },
    '/v1/workflows/import': {
      post: {
        summary: 'Create a workflow from an exported document; connections that do not resolve here are reported',
        tags: ['workflows'],
      },
    },
    '/v1/workflows/{id}/diff': { get: { summary: 'Diff two versions or a draft (from/to = version id or "draft")', tags: ['workflows'] } },
    '/v1/workflows/{id}/versions/{versionId}/rollback': { post: { summary: 'Roll back: publish an old version forward as a new version', tags: ['workflows'] } },
    '/v1/workflows/{id}/validate': { post: { summary: 'Validate the draft', tags: ['workflows'] } },
    '/v1/workflows/{id}/publish': { post: { summary: 'Publish a version', tags: ['workflows'] } },
    '/v1/workflows/{id}/activate': { post: { summary: 'Activate triggers', tags: ['workflows'] } },
    '/v1/workflows/{id}/deactivate': { post: { summary: 'Deactivate triggers', tags: ['workflows'] } },
    '/v1/workflows/{id}/execute': { post: { summary: 'Execute (Idempotency-Key supported)', tags: ['executions'] } },
    '/v1/workflows/{id}/callback': {
      put: { summary: 'Set the completion webhook (returns the signing secret once)', tags: ['workflows'] },
      delete: { summary: 'Clear the completion webhook', tags: ['workflows'] },
    },
    '/v1/executions/search': {
      get: {
        summary:
          'Find executions by a substring of the webhook body that started them (needs execution:run; minimum three characters)',
        tags: ['executions'],
      },
    },
    '/v1/executions/retry': {
      post: {
        summary:
          'Re-run every execution matching a filter (defaults to failures; dryRun counts first, capped per call, stops and reports on a quota refusal)',
        tags: ['executions'],
      },
    },
    '/v1/executions': {
      get: {
        summary:
          'List executions (server-side status filter, keyset paginated; a cursor is only valid for the filter it was issued under)',
        tags: ['executions'],
      },
    },
    '/v1/executions/{id}': { get: { summary: 'Get an execution timeline', tags: ['executions'] } },
    '/v1/executions/{id}/retry': { post: { summary: 'Replay as a new execution', tags: ['executions'] } },
    '/v1/executions/{id}/cancel': { post: { summary: 'Cancel a running execution', tags: ['executions'] } },
    '/v1/executions/{id}/approvals/{nodeId}': { post: { summary: 'Approve or reject a pending approval', tags: ['approvals'] } },
    '/v1/approvals': { get: { summary: 'List pending approvals', tags: ['approvals'] } },
    '/v1/usage': { get: { summary: 'Usage totals + daily series (from/to, default current month)', tags: ['usage'] } },
    '/v1/plan': {
      get: { summary: 'Plan, limits, usage and per-limit status', tags: ['billing'] },
      put: { summary: 'Change the plan or toggle overage', tags: ['billing'] },
    },
    '/v1/invoices': { get: { summary: 'List invoices', tags: ['billing'] } },
    '/v1/invoices/{id}': { get: { summary: 'Invoice with its line items', tags: ['billing'] } },
    '/v1/invoices/{id}/pay': { post: { summary: 'Create a charge with the configured provider', tags: ['billing'] } },
    '/v1/invoices/{id}/mark-paid': { post: { summary: 'Settle an invoice manually', tags: ['billing'] } },
    '/v1/payments/{provider}/webhook': {
      post: { summary: 'Signed provider callback', security: [], tags: ['billing'] },
    },
    '/v1/alerts': {
      get: { summary: 'List alert rules', tags: ['alerts'] },
      post: { summary: 'Create an alert rule (webhook secret returned once)', tags: ['alerts'] },
    },
    '/v1/alerts/{id}': {
      put: { summary: 'Update an alert rule', tags: ['alerts'] },
      delete: { summary: 'Delete an alert rule', tags: ['alerts'] },
    },
    '/v1/alerts/events': { get: { summary: 'Recent alert firings + unacknowledged count', tags: ['alerts'] } },
    '/v1/alerts/events/{id}/ack': { post: { summary: 'Acknowledge an alert firing', tags: ['alerts'] } },
    '/v1/workspaces/members': { get: { summary: 'List workspace members and roles', tags: ['workspaces'] } },
    '/v1/workspaces/members/{userId}': { put: { summary: "Change a member's role", tags: ['workspaces'] } },
    '/v1/templates': { get: { summary: 'Browse workflow templates (optional ?category)', tags: ['templates'] } },
    '/v1/templates/{id}': { get: { summary: 'Template detail incl. IR preview + required credentials', tags: ['templates'] } },
    '/v1/templates/{id}/clone': { post: { summary: 'Clone a template into a new workflow draft', tags: ['templates'] } },
    '/v1/connectors': { get: { summary: 'Connector catalog with param JSON Schemas', tags: ['connectors'] } },
    '/v1/connections': {
      get: { summary: 'List connections', tags: ['connections'] },
      post: { summary: 'Create a connection (secrets encrypted at rest)', tags: ['connections'] },
    },
    '/v1/connections/{id}': {
      put: {
        summary: 'Rotate a credential in place (whole payload; id and connector unchanged)',
        tags: ['connections'],
      },
      delete: { summary: 'Delete a connection', tags: ['connections'] },
    },
    '/v1/connections/{id}/test': { post: { summary: 'Test a connection', tags: ['connections'] } },
    '/v1/ai/generate': { post: { summary: 'Generate a workflow from a prompt', tags: ['ai'] } },
    '/v1/ai/edit': { post: { summary: 'Edit a workflow from a prompt', tags: ['ai'] } },
  },
} as const;
