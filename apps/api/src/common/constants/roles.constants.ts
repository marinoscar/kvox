// =============================================================================
// Role and permission constants (issue #465, epic #462)
// =============================================================================
//
// DERIVED, NOT DECLARED. The roles and permissions the platform's slices
// enforce are declared by `@marinoscar/platform-api` (`PLATFORM_ROLES`,
// `PLATFORM_PERMISSIONS`); this app's own eight domain permissions are declared in
// `app-registrations/permissions.ts`. This file only turns those declaration
// maps into the `ROLES` / `PERMISSIONS` constants the rest of the codebase
// imports, so a permission string can never drift from what the seed writes
// and what the guards check.
//
// It has no side effects: it registers nothing (that is
// `app-registrations/registrations.ts`).
//
// ROLE SEMANTICS CHANGED WITH THE PLATFORM. `admin` is the one SYSTEM role
// (held in `user_roles`); `org_admin`, `contributor` and `viewer` are ORG
// roles (held on a membership). `@Auth({ roles: ['admin'] })` therefore means
// "a deployment operator"; an org role never satisfies it.
// =============================================================================

import { permissionIds, roleIds } from '@marinoscar/platform-api/core';
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES } from '@marinoscar/platform-api/manifest';

import { KVOX_PERMISSIONS } from '../../app-registrations/permissions';

export const ROLES = roleIds(PLATFORM_ROLES);

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

export const PERMISSIONS = {
  ...permissionIds(PLATFORM_PERMISSIONS),
  ...permissionIds(KVOX_PERMISSIONS),
} as const;

export type PermissionName = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** The org role a new membership gets (the platform's `defaultOrgRole`). */
export const DEFAULT_ROLE = ROLES.VIEWER;

// Type the platform's `@Auth({ roles, permissions })` with this app's ids, so a
// typo in a permission string fails the typecheck instead of failing closed at
// run time.
declare module '@marinoscar/platform-api/identity' {
  interface IdentityPermissionIds extends Record<PermissionName, true> {}
  interface IdentityRoleIds extends Record<RoleName, true> {}
}
