/**
 * What the agent may ask to do, expressed in the same vocabulary as Xperiment's RBAC.
 *
 * These strings are deliberately a *subset* of `apps/api`'s `Permission` union rather
 * than a parallel one. `apps/api` asserts the subset relation with a single typed
 * assignment, so a tool inventing `workflow:god` is a compile error there rather than a
 * runtime 500 — and the agent package still does not import from the app, which would be
 * a dependency cycle.
 */
export type RequiredPermission = 'workflow:read' | 'workflow:write' | 'connection:read' | 'connection:write';

export type AgentToolId =
  | 'describe_node_type'
  | 'list_connections'
  | 'get_credential_guide'
  | 'list_workflows'
  | 'get_workflow'
  | 'create_workflow'
  | 'put_draft'
  | 'set_node_connection'
  | 'validate_workflow'
  | 'request_credential';

/**
 * Every tool the agent has, and the one permission it needs.
 *
 * Exhaustive over `AgentToolId`, so adding a tool id without deciding its permission does
 * not compile. There is no entry for publishing, activating, executing or deleting, and
 * their absence is load-bearing: the instructions tell the model it cannot do those, and
 * a model told it cannot behaves far better than one that finds no tool and improvises.
 */
export const AGENT_TOOL_PERMISSIONS: Record<AgentToolId, RequiredPermission> = {
  describe_node_type: 'workflow:read',
  list_connections: 'connection:read',
  // Static documentation rather than workspace data, so a viewer asking "how would I
  // connect Telegram?" deserves an answer.
  get_credential_guide: 'workflow:read',
  list_workflows: 'workflow:read',
  get_workflow: 'workflow:read',
  create_workflow: 'workflow:write',
  put_draft: 'workflow:write',
  set_node_connection: 'workflow:write',
  validate_workflow: 'workflow:read',
  // The permission needed to *complete* the action, not to ask for it: an operator who
  // cannot add credentials should be told so by name, rather than sent to a form that
  // will refuse them.
  request_credential: 'connection:write',
};

export const AGENT_TOOL_IDS = Object.keys(AGENT_TOOL_PERMISSIONS) as AgentToolId[];
