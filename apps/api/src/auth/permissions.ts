import type { Role } from '@xperiment/db';

export type Permission =
  | 'workflow:read'
  | 'workflow:write'
  | 'workflow:activate'
  | 'execution:read'
  | 'execution:run'
  | 'execution:cancel'
  | 'approval:decide'
  | 'connection:read'
  | 'connection:write'
  | 'alert:read'
  | 'alert:write'
  | 'usage:read'
  | 'billing:read'
  | 'billing:manage'
  | 'member:manage';

const READ_ONLY: Permission[] = ['workflow:read', 'execution:read', 'alert:read', 'usage:read'];
const RUNTIME: Permission[] = ['execution:run', 'execution:cancel', 'approval:decide', 'alert:write'];
const AUTHORING: Permission[] = ['workflow:write', 'workflow:activate', 'connection:read', 'connection:write'];
const BILLING: Permission[] = ['billing:read', 'billing:manage'];

const OPERATOR: Permission[] = [...READ_ONLY, ...RUNTIME];
const BUILDER: Permission[] = [...OPERATOR, ...AUTHORING];
const ADMIN: Permission[] = [...BUILDER, ...BILLING, 'member:manage'];

/**
 * Built-in role → permission sets. Deliberately a plain data structure: WS-006's
 * future custom roles can replace the source of this map without touching a route.
 *
 * Operator holds runtime rights without authoring; Billing is orthogonal to both.
 * Neither is expressible as a rank, which is why the old role ladder was removed.
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(READ_ONLY),
  operator: new Set(OPERATOR),
  billing: new Set<Permission>(['alert:read', 'usage:read', ...BILLING]),
  builder: new Set(BUILDER),
  admin: new Set(ADMIN),
  owner: new Set(ADMIN),
};

/** Every permission in the catalog — the matrix test asserts each one is routed. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  ...READ_ONLY,
  ...RUNTIME,
  ...AUTHORING,
  ...BILLING,
  'member:manage',
];

/** Fails closed: an unknown role has no permissions and never throws. */
export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
