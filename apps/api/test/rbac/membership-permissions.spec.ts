// =============================================================================
// The membership org-role path, without HTTP (issue #465, epic #462)
// =============================================================================
//
// Platform migration 0024 moved `contributor` and `viewer` from `user_roles` to
// `memberships.role_id`. KVox's own guard used to read only `user_roles`, so on
// a migrated database every non-admin had NO domain permission. These specs pin
// the replacement: a principal is built by the platform's `toPrincipal` from the
// platform's principal graph, and the eight KVox permissions come from the
// membership's org role, using the grants the seed actually writes
// (`prisma/catalog/permissions.json`) rather than a hand-written list.
//
// Covers both consumers of the path: the request guard (`toPrincipal`) and the
// out-of-request lookup the graph jobs use (`activeUserHoldsPermission`).
// =============================================================================

import { toPrincipal, type AuthenticatedUser } from '@marinoscar/platform-api/identity';

import { activeUserHoldsPermission } from '../../src/common/auth/principal-permissions';
import { principalUser } from '../fixtures/principal-user.fixture';
import { KVOX_DOMAIN_PERMISSIONS, catalogPermissionsOf } from '../helpers/membership-user.helper';

const principalOf = (user: ReturnType<typeof principalUser>) =>
  toPrincipal(user as unknown as AuthenticatedUser, 'session');

/** A user as the principal graph loads one: system roles, and one org-role membership. */
const userWith = (systemRole: string | null, orgRole: string | null) =>
  principalUser({
    systemRoles: systemRole ? [{ name: systemRole, permissions: catalogPermissionsOf(systemRole) }] : [],
    orgRole: orgRole ? { name: orgRole, permissions: catalogPermissionsOf(orgRole) } : null,
  });

describe('domain permissions come from the membership org role', () => {
  describe('the seed catalog', () => {
    it.each(['viewer', 'contributor', 'org_admin'])('grants the %s org role all eight KVox permissions', (role) => {
      expect(catalogPermissionsOf(role)).toEqual(expect.arrayContaining([...KVOX_DOMAIN_PERMISSIONS]));
    });

    it('grants the admin SYSTEM role none of them (migration 20261015125334 removed the grants)', () => {
      const adminGrants = catalogPermissionsOf('admin');

      for (const permission of KVOX_DOMAIN_PERMISSIONS) {
        expect(adminGrants).not.toContain(permission);
      }
    });
  });

  describe('toPrincipal', () => {
    it('gives a Viewer the eight permissions through the membership alone', () => {
      const viewer = userWith(null, 'viewer');

      // The shape that broke KVox's old guard: nothing in `user_roles`.
      expect(viewer.userRoles).toEqual([]);

      const principal = principalOf(viewer);

      expect(principal.roles).toEqual(['viewer']);

      for (const permission of KVOX_DOMAIN_PERMISSIONS) {
        expect(principal.permissions).toContain(permission);
      }
    });

    it('gives a Contributor the eight permissions through the membership', () => {
      const principal = principalOf(userWith(null, 'contributor'));

      for (const permission of KVOX_DOMAIN_PERMISSIONS) {
        expect(principal.permissions).toContain(permission);
      }
    });

    it('keeps an Admin working through org_admin: system admin role plus the org_admin membership', () => {
      const principal = principalOf(userWith('admin', 'org_admin'));

      expect(principal.roles).toEqual(expect.arrayContaining(['admin', 'org_admin']));
      expect(principal.permissions).toEqual(
        expect.arrayContaining([...KVOX_DOMAIN_PERMISSIONS, 'users:read', 'system_settings:write']),
      );
    });

    it('does NOT give the admin system role the domain permissions on its own', () => {
      const principal = principalOf(userWith('admin', null));

      expect(principal.permissions).toContain('users:read');

      for (const permission of KVOX_DOMAIN_PERMISSIONS) {
        expect(principal.permissions).not.toContain(permission);
      }
    });

    it('gives a user with no membership no domain permission', () => {
      const principal = principalOf(userWith(null, null));

      for (const permission of KVOX_DOMAIN_PERMISSIONS) {
        expect(principal.permissions).not.toContain(permission);
      }
    });

    it('ignores a membership that is not active', () => {
      const user = userWith(null, 'viewer');
      (user.memberships[0] as { status: string }).status = 'suspended';

      const principal = principalOf(user);

      expect(principal.permissions).not.toContain('transcripts:read');
    });

    it('does not give a Viewer the administrative permissions an Admin holds', () => {
      const principal = principalOf(userWith(null, 'viewer'));

      expect(principal.permissions).not.toContain('users:read');
      expect(principal.permissions).not.toContain('system_settings:write');
    });
  });

  describe('activeUserHoldsPermission (the out-of-request lookup the graph jobs use)', () => {
    const dbReturning = (user: unknown) => ({ user: { findFirst: jest.fn().mockResolvedValue(user) } });

    it('is true for a Viewer holding graph:write only through the membership', async () => {
      const db = dbReturning(userWith(null, 'viewer'));

      await expect(activeUserHoldsPermission(db as never, 'user-1', 'graph:write')).resolves.toBe(true);
      expect(db.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1', isActive: true } }),
      );
    });

    it('is true for an Admin through org_admin', async () => {
      const db = dbReturning(userWith('admin', 'org_admin'));

      await expect(activeUserHoldsPermission(db as never, 'user-1', 'graph:write')).resolves.toBe(true);
    });

    it('is false for an admin with no org_admin membership', async () => {
      const db = dbReturning(userWith('admin', null));

      await expect(activeUserHoldsPermission(db as never, 'user-1', 'graph:write')).resolves.toBe(false);
    });

    it('is false for an unknown or deactivated user', async () => {
      await expect(activeUserHoldsPermission(dbReturning(null) as never, 'gone', 'graph:write')).resolves.toBe(false);
    });
  });
});
