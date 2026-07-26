import { describe, expect, test } from 'vitest';
import { hasPermission, ROLE_PERMISSIONS, type Permission } from '../src/auth/permissions.js';

/** The authoritative table from the spec, written out literally (never derived from the implementation). */
const EXPECTED: Record<string, Permission[]> = {
  owner: ['workflow:read','workflow:write','workflow:activate','execution:read','execution:run','execution:cancel','approval:decide','connection:read','connection:write','alert:read','alert:write','usage:read','billing:read','billing:manage','member:manage'],
  admin: ['workflow:read','workflow:write','workflow:activate','execution:read','execution:run','execution:cancel','approval:decide','connection:read','connection:write','alert:read','alert:write','usage:read','billing:read','billing:manage','member:manage'],
  builder: ['workflow:read','workflow:write','workflow:activate','execution:read','execution:run','execution:cancel','approval:decide','connection:read','connection:write','alert:read','alert:write','usage:read'],
  operator: ['workflow:read','execution:read','execution:run','execution:cancel','approval:decide','alert:read','alert:write','usage:read'],
  billing: ['alert:read','usage:read','billing:read','billing:manage'],
  viewer: ['workflow:read','execution:read','alert:read','usage:read'],
};

describe('ROLE_PERMISSIONS', () => {
  test('every role grants exactly the documented permission set', () => {
    for (const [role, perms] of Object.entries(EXPECTED)) {
      expect([...ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS]].sort(), role).toEqual([...perms].sort());
    }
  });

  test('covers exactly the six roles', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['admin', 'billing', 'builder', 'operator', 'owner', 'viewer']);
  });

  test('every permission in the catalog is granted to at least one role', () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));
    const all = new Set(Object.values(EXPECTED).flat());
    expect([...all].filter((p) => !granted.has(p))).toEqual([]);
  });

  test('hasPermission fails closed and separates runtime from authoring', () => {
    expect(hasPermission('superuser' as never, 'workflow:read')).toBe(false);
    expect(hasPermission('operator', 'workflow:write')).toBe(false);
    expect(hasPermission('operator', 'execution:cancel')).toBe(true);
    expect(hasPermission('billing', 'connection:read')).toBe(false);
    expect(hasPermission('billing', 'usage:read')).toBe(true);
  });
});
