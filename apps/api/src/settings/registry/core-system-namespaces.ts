// =============================================================================
// Core system settings namespaces (issue #459)
// =============================================================================
//
// `notifications`, `jobs`, `nodes`, `databaseBackup` and `maintenance`: the
// namespaces that belong to the framework rather than to a domain module, each
// declared once as a `SystemSettingsNamespace`. `transcription` is declared in
// `transcription/transcription.system-settings.ts` and `ai` in
// `ai/ai.system-settings.ts`; `kvox.manifest.ts` registers them all, in the
// order that is the stored JSON's key order.
//
// STORED and PATCH shapes are the schemas that already exist in
// `common/schemas/settings.schema.ts`. The PUT and PATCH request-body branches
// and the response branches are the ones `settings/dto/*.dto.ts` write out by
// hand today (cut from `update-system-settings.dto.ts` and
// `system-settings-response.dto.ts`); the DTOs keep their copies until the
// composed schemas replace them, and `registry/composed-equivalence.spec.ts`
// proves the two stay identical meanwhile. The defaults are the ones in
// `common/types/settings.types.ts` (`DEFAULT_SYSTEM_SETTINGS`).
//
// NO `.default()` ANYWHERE: every default lives in the `defaults` of the
// declaration below and nowhere else, so "what does a fresh deployment do?" is
// answered by reading it, not by finding the first `parse` that ran.
// =============================================================================

import { z } from 'zod';

import {
  BACKUP_TIME_OF_DAY_PATTERN,
  DEFAULT_MAINTENANCE_MESSAGE,
  MAX_DISABLED_NOTIFICATION_EVENTS,
  systemDatabaseBackupPatchSchema,
  systemDatabaseBackupSchema,
  systemJobsPatchSchema,
  systemJobsSchema,
  systemMaintenancePatchSchema,
  systemMaintenanceSchema,
  systemNodesPatchSchema,
  systemNodesSchema,
  systemNotificationsSchema,
  type SystemDatabaseBackupValue,
  type SystemJobsValue,
  type SystemMaintenanceValue,
  type SystemNodesValue,
  type SystemNotificationsValue,
} from '../../common/schemas/settings.schema';
import { notificationEventKeySchema } from '../../common/schemas/user-settings-namespaces.schema';
import type { SystemSettingsNamespace } from './system-settings-namespace';

declare module './index' {
  interface SystemSettingsNamespaces {
    notifications: SystemNotificationsValue;
    jobs: SystemJobsValue;
    nodes: SystemNodesValue;
    databaseBackup: SystemDatabaseBackupValue;
    maintenance: SystemMaintenanceValue;
  }
}

// -----------------------------------------------------------------------------
// notifications (#225, epic #215)
// -----------------------------------------------------------------------------

/**
 * `disabledEvents` REPLACES wholesale rather than merging, which is both RFC
 * 7396's rule for arrays and the only sane one here: a merge has no way to
 * express "re-enable this event", so a patch that could only ever add would
 * make the admin page's uncheck a no-op.
 */
const notificationsPatchSchema = z.object({
  browserEnabled: z.boolean().optional(),
  disabledEvents: z
    .array(notificationEventKeySchema)
    .max(MAX_DISABLED_NOTIFICATION_EVENTS)
    .optional(),
});

/** The PUT branch: REQUIRED, so a PUT that omits it is a 400 and not a silent reset. */
const notificationsPutSchema = z.object({
  browserEnabled: z.boolean(),
  disabledEvents: z
    .array(notificationEventKeySchema)
    .max(MAX_DISABLED_NOTIFICATION_EVENTS),
});

export const NOTIFICATIONS_SYSTEM_SETTINGS: SystemSettingsNamespace<
  'notifications',
  SystemNotificationsValue
> = {
  key: 'notifications',
  description: 'Deployment-wide browser-notification policy: the browser channel switch and silenced events.',
  storedSchema: systemNotificationsSchema,
  patchSchema: notificationsPatchSchema,
  // Required: the value a PUT would reset is an operator's decision to turn a
  // delivery channel off for everyone.
  putSchema: notificationsPutSchema,
  wirePatchSchema: notificationsPatchSchema,
  responseSchema: z.object({
    browserEnabled: z.boolean(),
    disabledEvents: z.array(z.string()),
  }),
  // ON by default, suppressing nothing. The opposite default would mean a fresh
  // deployment ships with a delivery channel silently off and no indication
  // anywhere that it was ever available — an operator opts OUT of browser
  // notifications, never into them.
  defaults: {
    browserEnabled: true,
    disabledEvents: [],
  },
  requiredOnPut: true,
};

// -----------------------------------------------------------------------------
// Operations namespaces (#256, epic #254): jobs, nodes, databaseBackup, maintenance
// -----------------------------------------------------------------------------
//
// OPTIONAL in the PUT body while `notifications` is required: these shipped
// AHEAD of every consumer, so requiring them would 400 every existing client.
// An omitted block is carried forward from the stored value by
// `SystemSettingsService.replaceSettings`, never reset to the defaults.

const jobsPutSchema = z.object({
  history: z.object({
    retentionDays: z.number().int().min(1).max(3650),
    purgeEnabled: z.boolean(),
  }),
  stuckThresholdMinutes: z.number().int().min(1).max(10080),
});

const jobsWirePatchSchema = z.object({
  history: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).optional(),
      purgeEnabled: z.boolean().optional(),
    })
    .optional(),
  stuckThresholdMinutes: z.number().int().min(1).max(10080).optional(),
});

export const JOBS_SYSTEM_SETTINGS: SystemSettingsNamespace<'jobs', SystemJobsValue> = {
  key: 'jobs',
  description: 'Job-queue policy: history retention and the stuck-job threshold.',
  storedSchema: systemJobsSchema,
  patchSchema: systemJobsPatchSchema,
  putSchema: jobsPutSchema,
  wirePatchSchema: jobsWirePatchSchema,
  responseSchema: z.object({
    history: z.object({
      retentionDays: z.number(),
      purgeEnabled: z.boolean(),
    }),
    stuckThresholdMinutes: z.number(),
  }),
  // INERT: `purgeEnabled` is the only one that is on, and it only bounds a
  // table nothing writes to unboundedly.
  defaults: {
    history: {
      retentionDays: 30,
      purgeEnabled: true,
    },
    stuckThresholdMinutes: 30,
  },
  requiredOnPut: false,
};

const nodesPutSchema = z.object({
  staleHeartbeatSeconds: z.number().int().min(5).max(86400),
  offlineStaleMultiplier: z.number().int().min(1).max(100),
  offlineRetentionDays: z.number().int().min(1).max(3650),
  jobSecretBrokerEnabled: z.boolean(),
});

const nodesWirePatchSchema = z.object({
  staleHeartbeatSeconds: z.number().int().min(5).max(86400).optional(),
  offlineStaleMultiplier: z.number().int().min(1).max(100).optional(),
  offlineRetentionDays: z.number().int().min(1).max(3650).optional(),
  jobSecretBrokerEnabled: z.boolean().optional(),
});

export const NODES_SYSTEM_SETTINGS: SystemSettingsNamespace<'nodes', SystemNodesValue> = {
  key: 'nodes',
  description: 'Worker-fleet policy: heartbeat staleness, offline retention and per-job credential brokering.',
  storedSchema: systemNodesSchema,
  patchSchema: systemNodesPatchSchema,
  putSchema: nodesPutSchema,
  wirePatchSchema: nodesWirePatchSchema,
  responseSchema: z.object({
    staleHeartbeatSeconds: z.number(),
    offlineStaleMultiplier: z.number(),
    offlineRetentionDays: z.number(),
    jobSecretBrokerEnabled: z.boolean(),
  }),
  defaults: {
    staleHeartbeatSeconds: 90,
    offlineStaleMultiplier: 4,
    offlineRetentionDays: 30,
    // ⚠ OFF, AND THE DEFAULT IS THE POINT (#349, epic #345). A fresh
    // deployment does not hand its worker fleet credentials to its own
    // database because somebody registered a node; an administrator turns
    // this on deliberately, having decided that those machines are inside the
    // trust boundary. Fail-closed also means a settings row that cannot be
    // read degrades to "no credentials for anyone", which is the safe
    // direction.
    jobSecretBrokerEnabled: false,
  },
  requiredOnPut: false,
};

const databaseBackupPutSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  timeOfDay: z
    .string()
    .regex(BACKUP_TIME_OF_DAY_PATTERN, 'Expected a 24-hour HH:MM time'),
  timezone: z.string().min(1).max(64),
  retentionCount: z.number().int().min(1).max(365),
  storageProvider: z.string().min(1).max(64),
  runStaleMinutes: z.number().int().min(1).max(10080),
  compressionLevel: z.number().int().min(0).max(9),
  restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
  oldDatabaseRetentionHours: z.number().int().min(1).max(8760),
  nodeOffloadEnabled: z.boolean(),
});

const databaseBackupWirePatchSchema = z.object({
  enabled: z.boolean().optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  timeOfDay: z
    .string()
    .regex(BACKUP_TIME_OF_DAY_PATTERN, 'Expected a 24-hour HH:MM time')
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  retentionCount: z.number().int().min(1).max(365).optional(),
  storageProvider: z.string().min(1).max(64).optional(),
  runStaleMinutes: z.number().int().min(1).max(10080).optional(),
  compressionLevel: z.number().int().min(0).max(9).optional(),
  restoreRollbackMode: z.enum(['retain_database', 'drop_database']).optional(),
  oldDatabaseRetentionHours: z.number().int().min(1).max(8760).optional(),
  nodeOffloadEnabled: z.boolean().optional(),
});

export const DATABASE_BACKUP_SYSTEM_SETTINGS: SystemSettingsNamespace<
  'databaseBackup',
  SystemDatabaseBackupValue
> = {
  key: 'databaseBackup',
  description: 'Database backup and restore policy: schedule, retention, rollback mode and node offload.',
  storedSchema: systemDatabaseBackupSchema,
  patchSchema: systemDatabaseBackupPatchSchema,
  putSchema: databaseBackupPutSchema,
  wirePatchSchema: databaseBackupWirePatchSchema,
  responseSchema: z.object({
    enabled: z.boolean(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    dayOfWeek: z.number(),
    dayOfMonth: z.number(),
    timeOfDay: z.string(),
    timezone: z.string(),
    retentionCount: z.number(),
    storageProvider: z.string(),
    runStaleMinutes: z.number(),
    compressionLevel: z.number(),
    restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
    oldDatabaseRetentionHours: z.number(),
    nodeOffloadEnabled: z.boolean(),
  }),
  defaults: {
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
    // OFF, like `nodes.jobSecretBrokerEnabled` and for a related-but-distinct
    // reason (#352, epic #345): a fresh deployment does not ship its entire
    // database off the API server because somebody registered a worker node.
    // Both switches must be on, and the credential broker must report itself
    // usable, before `db.backup.run` is offered to a node at all.
    nodeOffloadEnabled: false,
  },
  requiredOnPut: false,
};

const maintenancePutSchema = z.object({
  enabled: z.boolean(),
  message: z.string().min(1).max(1000),
  allowAdmins: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  startedById: z.string().uuid().nullable(),
});

// `startedAt` and `startedById` are `.nullable().optional()`: `null` clears
// the window's provenance, absent leaves it alone. The service's merge
// distinguishes the two with `!== undefined` rather than `??`.
const maintenanceWirePatchSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().min(1).max(1000).optional(),
  allowAdmins: z.boolean().optional(),
  startedAt: z.iso.datetime().nullable().optional(),
  startedById: z.string().uuid().nullable().optional(),
});

export const MAINTENANCE_SYSTEM_SETTINGS: SystemSettingsNamespace<
  'maintenance',
  SystemMaintenanceValue
> = {
  key: 'maintenance',
  description: 'Maintenance-window state: the banner, whether admins may still sign in, and who opened the window.',
  storedSchema: systemMaintenanceSchema,
  patchSchema: systemMaintenancePatchSchema,
  putSchema: maintenancePutSchema,
  wirePatchSchema: maintenanceWirePatchSchema,
  responseSchema: z.object({
    enabled: z.boolean(),
    message: z.string(),
    allowAdmins: z.boolean(),
    startedAt: z.string().nullable(),
    startedById: z.string().nullable(),
  }),
  defaults: {
    enabled: false,
    // Shared with the schema so the banner's copy and its validation cannot
    // disagree, and so a fork renaming its product finds no product name here
    // to rename.
    message: DEFAULT_MAINTENANCE_MESSAGE,
    allowAdmins: true,
    startedAt: null,
    startedById: null,
  },
  requiredOnPut: false,
};

/**
 * The core system namespaces, in the order that is the stored JSON's key order.
 * `kvox.manifest.ts` appends `transcription` and `ai` after these.
 */
export const CORE_SYSTEM_NAMESPACES: readonly SystemSettingsNamespace[] = [
  NOTIFICATIONS_SYSTEM_SETTINGS,
  JOBS_SYSTEM_SETTINGS,
  NODES_SYSTEM_SETTINGS,
  DATABASE_BACKUP_SYSTEM_SETTINGS,
  MAINTENANCE_SYSTEM_SETTINGS,
];
