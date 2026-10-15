// =============================================================================
// Users whose permissions come from the platform's real role graph (issue #465)
// =============================================================================
//
// Platform migration `0024_split_system_org_roles` moved `contributor` and
// `viewer` from `user_roles` onto `memberships.role_id`: they are ORG roles now,
// and `admin` is the only SYSTEM role (it reaches the eight KVox domain
// permissions through its `org_admin` membership, not through `admin`).
//
// `createMockTestUser` (auth-mock.helper.ts) still builds the old shape (every
// role in `userRoles`, with a generous hand-written permission list). This
// helper builds the shape production has, from the SAME catalog the seed writes
// (`prisma/catalog/permissions.json`), so a spec that asserts "a Viewer can read
// transcripts" is asserting the real grant and not a fixture that was generous.
// =============================================================================

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JwtService } from '@nestjs/jwt';

import { registerMockUserRecord } from '../fixtures/mock-setup.helper';
import { createMockUserWithRelations } from '../fixtures/test-data.factory';
import type { TestUser } from './auth-mock.helper';
import type { TestContext } from './test-app.helper';

interface Catalog {
  roles: Array<{ name: string; scope: 'system' | 'org' }>;
  rolePermissions: Record<string, string[]>;
}

const CATALOG: Catalog = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'prisma', 'catalog', 'permissions.json'), 'utf8'),
);

/** The eight domain permissions KVox registers as org-scoped (#465). */
export const KVOX_DOMAIN_PERMISSIONS = [
  'transcripts:read',
  'transcripts:write',
  'notes:read',
  'notes:write',
  'note_templates:read',
  'note_templates:write',
  'graph:read',
  'graph:write',
] as const;

/** The permissions the seed grants `roleName` (system or org), straight from the catalog. */
export function catalogPermissionsOf(roleName: string): string[] {
  const permissions = CATALOG.rolePermissions[roleName];

  if (!permissions) throw new Error(`Role "${roleName}" is not in prisma/catalog/permissions.json`);

  return permissions;
}

function roleRecord(roleName: string) {
  const roleId = randomUUID();

  return {
    id: roleId,
    name: roleName,
    description: null,
    rolePermissions: catalogPermissionsOf(roleName).map((name) => ({
      roleId,
      permissionId: `perm-${name}`,
      permission: { id: `perm-${name}`, name, description: null },
    })),
  };
}

export interface MembershipUserOptions {
  email?: string;
  /** System roles held in `user_roles`. Default none. */
  systemRoles?: string[];
  /** The org role of the default-organization membership; `null` for no membership. Default `viewer`. */
  orgRole?: string | null;
  isActive?: boolean;
}

/**
 * Registers a user shaped like production and returns a signed access token.
 * `systemRoles` go to `user_roles`; `orgRole` goes to the default organization's
 * ACTIVE membership.
 */
export async function createMembershipUser(
  context: TestContext,
  options: MembershipUserOptions = {},
): Promise<TestUser> {
  const base = createMockUserWithRelations({ email: options.email, isActive: options.isActive });
  const systemRoles = options.systemRoles ?? [];
  const orgRole = options.orgRole === undefined ? 'viewer' : options.orgRole;
  const orgId = 'org-default';

  const record = {
    ...base,
    userRoles: systemRoles.map((name) => {
      const role = roleRecord(name);

      return { userId: base.id, roleId: role.id, role };
    }),
    memberships: orgRole
      ? [
          {
            orgId,
            userId: base.id,
            status: 'active' as const,
            lastActiveAt: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            org: { id: orgId, isDefault: true },
            role: roleRecord(orgRole),
          },
        ]
      : [],
  };

  registerMockUserRecord(record);

  const roles = [...systemRoles, ...(orgRole ? [orgRole] : [])];
  const accessToken = context.module.get(JwtService).sign({
    sub: record.id,
    email: record.email,
    roles,
  });

  return { id: record.id, email: record.email, roles, accessToken };
}

/** A Viewer exactly as production stores one: no `user_roles` row, an org-role membership. */
export const createMembershipViewer = (context: TestContext, email?: string) =>
  createMembershipUser(context, { email, orgRole: 'viewer' });

/** A Contributor exactly as production stores one. */
export const createMembershipContributor = (context: TestContext, email?: string) =>
  createMembershipUser(context, { email, orgRole: 'contributor' });

/** An Admin exactly as production stores one: the `admin` SYSTEM role plus an `org_admin` membership. */
export const createMembershipAdmin = (context: TestContext, email?: string) =>
  createMembershipUser(context, { email, systemRoles: ['admin'], orgRole: 'org_admin' });
