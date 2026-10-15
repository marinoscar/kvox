// =============================================================================
// A user as the platform's principal graph loads it (issue #465)
// =============================================================================
//
// `PRINCIPAL_USER_INCLUDE` loads a user with their SYSTEM roles (`userRoles`)
// and their memberships with each membership's ORG role. Domain permissions
// (`graph:write`, `transcripts:read`, ...) are org-scoped, so a Contributor or
// Viewer holds them through a membership. This builds that graph for a unit
// test that mocks `prisma.user.findFirst` / `findUnique`.
// =============================================================================

export interface PrincipalUserOptions {
  id?: string;
  email?: string;
  isActive?: boolean;
  /** System role names (`user_roles`), with the permissions each carries. */
  systemRoles?: Array<{ name: string; permissions?: string[] }>;
  /** The org role of the default membership and the permissions it carries. */
  orgRole?: { name: string; permissions: string[] } | null;
}

const rolePermissions = (permissions: string[]) =>
  permissions.map((name) => ({ permission: { id: `perm-${name}`, name, description: null } }));

export function principalUser(options: PrincipalUserOptions = {}) {
  const orgRole = options.orgRole === undefined ? { name: 'viewer', permissions: [] } : options.orgRole;

  return {
    id: options.id ?? 'user-1',
    email: options.email ?? 'user@example.com',
    isActive: options.isActive ?? true,
    userRoles: (options.systemRoles ?? []).map((role) => ({
      role: {
        id: `role-${role.name}`,
        name: role.name,
        description: null,
        rolePermissions: rolePermissions(role.permissions ?? []),
      },
    })),
    memberships: orgRole
      ? [
          {
            orgId: 'org-default',
            status: 'active' as const,
            lastActiveAt: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            org: { id: 'org-default', isDefault: true },
            role: {
              id: `role-${orgRole.name}`,
              name: orgRole.name,
              description: null,
              rolePermissions: rolePermissions(orgRole.permissions),
            },
          },
        ]
      : [],
  };
}

/** A viewer-role member holding exactly `permissions` through their membership. */
export function memberHolding(permissions: string[], options: PrincipalUserOptions = {}) {
  return principalUser({ ...options, orgRole: { name: 'viewer', permissions } });
}
