import { randomUUID } from 'crypto';

/**
 * Test data factories for creating mock entities
 * These create in-memory objects without database calls
 *
 * NOTE: These factories return plain objects that match Prisma types.
 * They intentionally don't import Prisma types directly to avoid
 * strict type checking issues in tests.
 */

// ============================================================================
// Roles and Permissions
// ============================================================================

export const mockPermissions = {
  systemSettingsRead: {
    id: randomUUID(),
    name: 'system_settings:read',
    description: 'Read system settings',
  },
  systemSettingsWrite: {
    id: randomUUID(),
    name: 'system_settings:write',
    description: 'Modify system settings',
  },
  userSettingsRead: {
    id: randomUUID(),
    name: 'user_settings:read',
    description: 'Read user settings',
  },
  userSettingsWrite: {
    id: randomUUID(),
    name: 'user_settings:write',
    description: 'Modify user settings',
  },
  usersRead: {
    id: randomUUID(),
    name: 'users:read',
    description: 'Read user data',
  },
  usersWrite: {
    id: randomUUID(),
    name: 'users:write',
    description: 'Modify user data',
  },
  rbacManage: {
    id: randomUUID(),
    name: 'rbac:manage',
    description: 'Manage roles and permissions',
  },
  allowlistRead: {
    id: randomUUID(),
    name: 'allowlist:read',
    description: 'Read allowlist',
  },
  allowlistWrite: {
    id: randomUUID(),
    name: 'allowlist:write',
    description: 'Modify allowlist',
  },
  // The background queue's admin surface (#264, epic #254). Seeded to Admin
  // only in `prisma/seed-data.ts`, and mirrored that way below.
  jobsRead: {
    id: randomUUID(),
    name: 'jobs:read',
    description: 'View queued, running and completed jobs',
  },
  jobsWrite: {
    id: randomUUID(),
    name: 'jobs:write',
    description: 'Enqueue, retry and cancel jobs',
  },
  // The worker fleet (#267, epic #254). Split from `jobs:*` deliberately —
  // see `common/constants/roles.constants.ts` — and, like the queue's pair,
  // seeded to Admin ONLY in `prisma/seed-data.ts`. Mirrored that way below so
  // an integration test that expects a viewer to be refused a node surface is
  // testing the real grant and not a fixture that happened to be generous.
  nodesRead: {
    id: randomUUID(),
    name: 'nodes:read',
    description: 'View worker nodes and their health',
  },
  nodesWrite: {
    id: randomUUID(),
    name: 'nodes:write',
    description: 'Register, drain and remove worker nodes',
  },
  // Admin notification broadcasts (#320/#324, epic #319). Seeded to Admin ONLY
  // in `prisma/seed-data.ts` and mirrored that way below: a broadcast reaches
  // every active user in the deployment, so an integration test that expects a
  // viewer to be refused these routes must be testing the real grant rather
  // than a fixture that happened to be generous.
  broadcastsRead: {
    id: randomUUID(),
    name: 'broadcasts:read',
    description: 'View notification broadcasts and their delivery history',
  },
  broadcastsWrite: {
    id: randomUUID(),
    name: 'broadcasts:write',
    description: 'Compose, schedule, cancel and send notification broadcasts',
  },
  // Database backup (#283, epic #254). Seeded to Admin ONLY in
  // `prisma/seed-data.ts`, and mirrored that way below — a fixture that were
  // more generous than the seed would make an integration test asserting that a
  // viewer is refused pass for the wrong reason.
  //
  // `db_backup:restore` gates the two routes that replace the production
  // database (#286) and nothing else; it is seeded to Admin like the other two.
  // A spec that needs the OPPOSITE — an Admin who may schedule backups but must
  // NOT be able to restore — narrows this fixture per request rather than
  // weakening it here, because the fixture's job is to mirror the seed.
  dbBackupRead: {
    id: randomUUID(),
    name: 'db_backup:read',
    description: 'View backup schedule, history and status',
  },
  dbBackupWrite: {
    id: randomUUID(),
    name: 'db_backup:write',
    description: 'Configure the backup schedule and run a backup',
  },
  dbBackupRestore: {
    id: randomUUID(),
    name: 'db_backup:restore',
    description: 'Restore the database from a backup',
  },
  // Runtime-configurable Web Push (VAPID) admin UI (#355). Seeded to Admin
  // ONLY in `prisma/seed-data.ts`, and mirrored that way below — split from
  // `system_settings:*` deliberately (see `common/constants/roles.constants.ts`),
  // so a fixture that granted it more broadly than the seed would make an
  // integration test asserting a viewer is refused pass for the wrong reason.
  pushRead: {
    id: randomUUID(),
    name: 'push:read',
    description: 'View the Web Push (VAPID) configuration',
  },
  pushWrite: {
    id: randomUUID(),
    name: 'push:write',
    description: 'Generate, rotate, enable/disable and remove the Web Push key pair',
  },
};

export const mockRoles = {
  admin: {
    id: randomUUID(),
    name: 'admin',
    description: 'Full system access',
  },
  contributor: {
    id: randomUUID(),
    name: 'contributor',
    description: 'Standard user capabilities',
  },
  viewer: {
    id: randomUUID(),
    name: 'viewer',
    description: 'Read-only access',
  },
};

// ============================================================================
// User Factory
// ============================================================================

export interface CreateMockUserOptions {
  id?: string;
  email?: string;
  displayName?: string | null;
  providerDisplayName?: string | null;
  profileImageUrl?: string | null;
  providerProfileImageUrl?: string | null;
  isActive?: boolean;
  roleName?: 'admin' | 'contributor' | 'viewer';
  createdAt?: Date;
  updatedAt?: Date;
}

export function createMockUser(options: CreateMockUserOptions = {}): any {
  const timestamp = Date.now();
  const {
    id = randomUUID(),
    email = `test-${timestamp}@example.com`,
    displayName = null,
    providerDisplayName = 'Test User',
    profileImageUrl = null,
    providerProfileImageUrl = 'https://example.com/photo.jpg',
    isActive = true,
    createdAt = new Date(),
    updatedAt = new Date(),
  } = options;

  return {
    id,
    email,
    displayName,
    providerDisplayName,
    profileImageUrl,
    providerProfileImageUrl,
    isActive,
    createdAt,
    updatedAt,
  };
}

// ============================================================================
// User Identity Factory
// ============================================================================

export interface CreateMockUserIdentityOptions {
  id?: string;
  userId: string;
  provider?: string;
  providerSubject?: string;
  providerEmail?: string | null;
  createdAt?: Date;
}

export function createMockUserIdentity(
  options: CreateMockUserIdentityOptions,
): any {
  const timestamp = Date.now();
  const {
    id = randomUUID(),
    userId,
    provider = 'google',
    providerSubject = `google-${timestamp}`,
    providerEmail = `test-${timestamp}@example.com`,
    createdAt = new Date(),
  } = options;

  return {
    id,
    userId,
    provider,
    providerSubject,
    providerEmail,
    createdAt,
  };
}

// ============================================================================
// User Role Factory
// ============================================================================

export interface CreateMockUserRoleOptions {
  userId: string;
  roleId: string;
}

export function createMockUserRole(options: CreateMockUserRoleOptions): any {
  const { userId, roleId } = options;

  // UserRole has composite primary key [userId, roleId], no id field
  return {
    userId,
    roleId,
  };
}

// ============================================================================
// User Settings Factory
// ============================================================================

export interface CreateMockUserSettingsOptions {
  id?: string;
  userId: string;
  value?: any;
  version?: number;
  updatedAt?: Date;
}

export function createMockUserSettings(
  options: CreateMockUserSettingsOptions,
): any {
  const {
    id = randomUUID(),
    userId,
    value = {
      theme: 'system',
      profile: {
        displayName: null,
        imageSource: 'provider',
        imageObjectId: null,
      },
      updatedAt: new Date().toISOString(),
      version: 1,
    },
    version = 1,
    updatedAt = new Date(),
  } = options;

  return {
    id,
    userId,
    value,
    version,
    updatedAt,
  };
}

// ============================================================================
// System Settings Factory
// ============================================================================

export interface CreateMockSystemSettingsOptions {
  id?: string;
  key?: string;
  value?: any;
  version?: number;
  updatedByUserId?: string | null;
  updatedAt?: Date;
}

export function createMockSystemSettings(
  options: CreateMockSystemSettingsOptions = {},
): any {
  const {
    id = randomUUID(),
    key = 'default',
    value = {
      notifications: { browserEnabled: true, disabledEvents: [] },
      jobs: {
        history: { retentionDays: 30, purgeEnabled: true },
        stuckThresholdMinutes: 30,
      },
      nodes: {
        staleHeartbeatSeconds: 90,
        offlineStaleMultiplier: 4,
        offlineRetentionDays: 30,
        jobSecretBrokerEnabled: false,
      },
    },
    version = 1,
    updatedByUserId = null,
    updatedAt = new Date(),
  } = options;

  return {
    id,
    key,
    value,
    version,
    updatedByUserId,
    updatedAt,
  };
}

// ============================================================================
// Allowed Email Factory
// ============================================================================

export interface CreateMockAllowedEmailOptions {
  id?: string;
  email: string;
  notes?: string | null;
  addedById?: string | null;
  claimedById?: string | null;
  claimedAt?: Date | null;
  addedAt?: Date;
}

export function createMockAllowedEmail(
  options: CreateMockAllowedEmailOptions,
): any {
  const {
    id = randomUUID(),
    email,
    notes = null,
    addedById = null,
    claimedById = null,
    claimedAt = null,
    addedAt = new Date(),
  } = options;

  return {
    id,
    email: email.toLowerCase(),
    notes,
    addedById,
    claimedById,
    claimedAt,
    addedAt,
  };
}

// ============================================================================
// Audit Event Factory
// ============================================================================

export interface CreateMockAuditEventOptions {
  id?: string;
  actorUserId?: string | null;
  action: string;
  targetId: string;
  targetType: string;
  meta?: any;
  createdAt?: Date;
}

export function createMockAuditEvent(options: CreateMockAuditEventOptions): any {
  const {
    id = randomUUID(),
    actorUserId = null,
    action,
    targetId,
    targetType,
    meta = {},
    createdAt = new Date(),
  } = options;

  return {
    id,
    actorUserId,
    action,
    targetId,
    targetType,
    meta,
    createdAt,
  };
}

// ============================================================================
// Role Permissions Mapping
// ============================================================================

/**
 * Maps role names to their permissions
 * This mirrors the actual RBAC configuration
 */
export const rolePermissionsMap = {
  admin: [
    mockPermissions.systemSettingsRead,
    mockPermissions.systemSettingsWrite,
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
    mockPermissions.usersRead,
    mockPermissions.usersWrite,
    mockPermissions.rbacManage,
    mockPermissions.allowlistRead,
    mockPermissions.allowlistWrite,
    mockPermissions.jobsRead,
    mockPermissions.jobsWrite,
    mockPermissions.nodesRead,
    mockPermissions.nodesWrite,
    mockPermissions.broadcastsRead,
    mockPermissions.broadcastsWrite,
    mockPermissions.dbBackupRead,
    mockPermissions.dbBackupWrite,
    mockPermissions.dbBackupRestore,
    mockPermissions.pushRead,
    mockPermissions.pushWrite,
  ],
  contributor: [
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
  ],
  viewer: [
    mockPermissions.userSettingsRead,
    mockPermissions.userSettingsWrite,
  ],
};

// ============================================================================
// Complete User with Relations
// ============================================================================

export interface MockUserWithRelations {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  userRoles?: Array<{
    userId: string;
    roleId: string;
    role: {
      id: string;
      name: string;
      description: string | null;
      rolePermissions: Array<{
        roleId: string;
        permissionId: string;
        permission: { id: string; name: string; description: string | null };
      }>;
    };
  }>;
  identities?: any[];
  userSettings?: any;
}

export function createMockUserWithRelations(
  options: CreateMockUserOptions = {},
): MockUserWithRelations {
  const user = createMockUser(options);
  const roleName = options.roleName || 'viewer';
  const role = mockRoles[roleName];

  // Get permissions for this role
  const permissions = rolePermissionsMap[roleName] || [];

  // Build the full nested structure matching AuthenticatedUser type
  const roleWithPermissions = {
    ...role,
    rolePermissions: permissions.map((permission) => ({
      roleId: role.id,
      permissionId: permission.id,
      permission,
    })),
  };

  const userRole = createMockUserRole({
    userId: user.id,
    roleId: role.id,
  });

  const identity = createMockUserIdentity({
    userId: user.id,
    providerEmail: user.email,
  });

  const settings = createMockUserSettings({
    userId: user.id,
  });

  return {
    ...user,
    userRoles: [{ ...userRole, role: roleWithPermissions }],
    identities: [identity],
    userSettings: settings,
  };
}
