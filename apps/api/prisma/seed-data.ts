// =============================================================================
// Seed Data Definitions
// =============================================================================
//
// The declarative half of `seed.ts`, in a module of its own so it can be
// asserted by a test (#256, epic #254). `seed.ts` instantiates a PrismaClient
// and calls `main()` at import time — it is a script, not a module — so nothing
// in a Jest run can import it to check that the roles it seeds actually name
// permissions it declares, or that the system-settings blob it writes still
// matches the API's `DEFAULT_SYSTEM_SETTINGS`. Splitting the data out costs one
// import and buys `test/prisma/seed-data.spec.ts`.
//
// This file stays framework-free and dependency-free on purpose: it is compiled
// by `prisma/tsconfig.json` under ts-node when `npm run prisma:seed` runs, with
// no Nest build anywhere in sight.
//
// IDEMPOTENCE IS A PROPERTY OF `seed.ts`, NOT OF THIS FILE — every write there
// is an `upsert` keyed on a natural unique (`role.name`, `permission.name`,
// `rolePermission.roleId_permissionId`, `systemSettings.key`), so a second run
// updates the same rows instead of inserting duplicates. What this file
// contributes is that the data itself contains no duplicates to insert, which
// the spec checks.

export const ROLES = [
  {
    name: 'admin',
    description: 'Full system access - manage users, roles, and all settings',
  },
  {
    name: 'contributor',
    description: 'Standard user - can manage own settings and future features',
  },
  {
    name: 'viewer',
    description: 'Read-only access - can view content and manage own settings',
  },
] as const;

export const PERMISSIONS = [
  // System settings
  { name: 'system_settings:read', description: 'Read system settings' },
  { name: 'system_settings:write', description: 'Modify system settings' },

  // User settings
  { name: 'user_settings:read', description: 'Read own user settings' },
  { name: 'user_settings:write', description: 'Modify own user settings' },

  // Users management
  { name: 'users:read', description: 'View user list and details' },
  { name: 'users:write', description: 'Modify user accounts' },

  // RBAC management
  { name: 'rbac:manage', description: 'Manage roles and permissions' },

  // Allowlist management
  { name: 'allowlist:read', description: 'View allowlisted emails' },
  { name: 'allowlist:write', description: 'Manage allowlisted emails' },

  // Storage management
  { name: 'storage:read', description: 'Read object metadata, get download URLs' },
  { name: 'storage:write', description: 'Upload, update metadata' },
  { name: 'storage:delete_any', description: 'Admin: delete any object' },

  // Jobs — the background queue (#256, epic #254)
  { name: 'jobs:read', description: 'View queued, running and completed jobs' },
  { name: 'jobs:write', description: 'Enqueue, retry and cancel jobs' },

  // Worker nodes — the fleet that executes those jobs (#256, epic #254).
  //
  // A SEPARATE PAIR FROM `jobs:*` on purpose. A settings card's `permission`
  // must be the exact string its controller enforces (CLAUDE.md, Settings UI
  // Pattern rule 3), so a Workers card gated on `jobs:read` would mirror a
  // permission the nodes controller never checks — the hub would decide
  // reachability on evidence unrelated to whether the request will be
  // authorized. They are also different questions: what work is queued, versus
  // which machines are attached to this deployment.
  { name: 'nodes:read', description: 'View worker nodes and their health' },
  { name: 'nodes:write', description: 'Register, drain and remove worker nodes' },

  // Database backup (#256, epic #254).
  //
  // `db_backup:restore` is a THIRD permission rather than part of `:write`
  // because the two acts are not comparable. Writing is routine scheduling and
  // is undone by writing again; restoring renames the live database and
  // restarts the process, interrupting every session. Folding restore into
  // write would mean anyone trusted to move a backup window is also trusted to
  // roll production back over the top of itself.
  { name: 'db_backup:read', description: 'View backup schedule, history and status' },
  { name: 'db_backup:write', description: 'Configure the backup schedule and run a backup' },
  { name: 'db_backup:restore', description: 'Restore the database from a backup' },

  // Notification broadcasts — admin messages fanned out to every user
  // (#320, epic #319). A separate pair from `system_settings:*`: broadcasting
  // is not editing the settings document, it's a one-way message to every
  // account in the deployment, so it gets its own controller-enforced
  // permission rather than mirroring one nothing in that controller checks.
  // Plural, matching `jobs:*`/`nodes:*`/`users:*` for a collection resource.
  {
    name: 'broadcasts:read',
    description: 'View notification broadcasts and their delivery history',
  },
  {
    name: 'broadcasts:write',
    description: 'Compose, schedule, cancel and send notification broadcasts',
  },

  // Web Push (VAPID) configuration (#355). A separate pair from
  // `system_settings:*`: generating or rotating the VAPID key pair knocks
  // every existing push subscriber offline until they resubscribe, which is
  // a materially different act from an ordinary settings edit and gets its
  // own controller-enforced permission rather than mirroring one nothing in
  // that controller checks.
  { name: 'push:read', description: 'View Web Push (VAPID) configuration' },
  {
    name: 'push:write',
    description: 'Generate, rotate, enable/disable and remove Web Push VAPID keys',
  },
] as const;

// Role to permissions mapping
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'system_settings:read',
    'system_settings:write',
    'user_settings:read',
    'user_settings:write',
    'users:read',
    'users:write',
    'rbac:manage',
    'allowlist:read',
    'allowlist:write',
    'storage:read',
    'storage:write',
    'storage:delete_any',
    // #256, epic #254 — ADMIN ONLY, including the read halves. Contributor and
    // Viewer are deliberately left off: the queue, the fleet and the backup
    // history are operational surfaces, and a read there exposes job payload
    // metadata, host names and the shape of the deployment's schedule. A later
    // issue can widen a specific read to Contributor with an argument for that
    // one surface; starting narrow is the direction that can be relaxed
    // without a migration, since these are rows.
    'jobs:read',
    'jobs:write',
    'nodes:read',
    'nodes:write',
    'db_backup:read',
    'db_backup:write',
    'db_backup:restore',
    // #320, epic #319 — ADMIN ONLY, same reasoning as the jobs/nodes/backup
    // trio just above: broadcasting reaches every user in the deployment, so
    // it starts as narrow as the other operational surfaces here and can be
    // widened later without a migration, since these are rows.
    'broadcasts:read',
    'broadcasts:write',
    // #355 — ADMIN ONLY, same reasoning: rotating VAPID keys knocks every
    // push subscriber offline, so it starts as narrow as the surfaces above
    // and can be widened later without a migration, since these are rows.
    'push:read',
    'push:write',
  ],
  contributor: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
    'storage:write',
  ],
  viewer: [
    'user_settings:read',
    'user_settings:write',
    'storage:read',
  ],
};

// Default system settings
// Must stay in step with `DEFAULT_SYSTEM_SETTINGS` in
// `src/common/types/settings.types.ts` — the seed cannot import it (this script
// runs outside the Nest build), so the two are a deliberate duplicate. A seeded
// row missing a modelled block is not fatal (`readKnownSettings` degrades it to
// the same defaults), but it does mean the first PATCH is what materialises it.
export const DEFAULT_SYSTEM_SETTINGS = {
  // #225, epic #215. Browser notifications on, nothing suppressed: an operator
  // opts OUT of the channel, never into it.
  notifications: {
    browserEnabled: true,
    disabledEvents: [] as string[],
  },
  // #256, epic #254. Inert defaults: backups and the maintenance window ship
  // off, and the only switch that is on bounds a history table nothing writes
  // to yet. `test/prisma/seed-data.spec.ts` asserts this object still equals
  // the API's `DEFAULT_SYSTEM_SETTINGS` key for key and value for value, which
  // is the only thing standing between the deliberate duplication above and a
  // seeded row that disagrees with the code reading it.
  jobs: {
    history: {
      retentionDays: 30,
      purgeEnabled: true,
    },
    stuckThresholdMinutes: 30,
  },
  nodes: {
    staleHeartbeatSeconds: 90,
    offlineStaleMultiplier: 4,
    offlineRetentionDays: 30,
    // OFF, and the default is the point (#349, epic #345): a fresh deployment
    // does not hand its worker fleet credentials to its own database because
    // somebody registered a node. An administrator opens that trust boundary
    // deliberately.
    jobSecretBrokerEnabled: false,
  },
  databaseBackup: {
    enabled: false,
    frequency: 'daily',
    dayOfWeek: 0,
    dayOfMonth: 1,
    timeOfDay: '02:00',
    timezone: 'UTC',
    retentionCount: 7,
    storageProvider: 's3',
    runStaleMinutes: 120,
    compressionLevel: 6,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 48,
    // OFF (#352, epic #345). Node offload needs TWO deliberate decisions —
    // this one and `nodes.jobSecretBrokerEnabled` above — because "these
    // machines may hold a short-lived credential" and "the whole database may
    // be dumped somewhere other than the API server" are different questions.
    nodeOffloadEnabled: false,
  },
  maintenance: {
    enabled: false,
    // Names no product and no repository — this is a template repo, and the
    // API-side copy of this string (`DEFAULT_MAINTENANCE_MESSAGE`) does not
    // either. A fork that wants its name here reads `APP_NAME` from
    // `@app/shared` at render time rather than baking it into a seeded row.
    message:
      'This service is temporarily unavailable for scheduled maintenance. Please try again shortly.',
    allowAdmins: true,
    startedAt: null as string | null,
    startedById: null as string | null,
  },
};
