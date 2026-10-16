// =============================================================================
// The database backup slice's composition (issue #471, epic #467)
// =============================================================================
//
// `DbBackupModule.forRoot` replaces this app's own `db-backup/` folder: the
// streaming `pg_dump` engine, the schedule and retention, the restore (read-only
// pre-flight, swap, rollback), the four job types (`db.backup.run`,
// `db.backup.sweep`, `db.restore.run`, `db.restore.old-db-drop`, strings
// unchanged), the per-job role broker for worker nodes, the
// `/api/admin/db-backup/*` routes (`db_backup:read|write|restore`) and the
// `backup.*` Doctor checks.
//
// Every dump and restore carries BOTH `--enable-row-security` and
// `PGOPTIONS=-c app.rls_bypass=on` (the platform does this; never wrap it): the
// flag alone writes an archive with empty organization tables.
//
// WHAT IT NEEDS FROM THIS APP, all already mounted: `jobsModule` and
// `settingsModule` (global), `platformHostModule` (`PLATFORM_PRISMA`),
// `doctorModule`, the storage provider (the default backup target is an adapter
// over the active `STORAGE_PROVIDER`), and the config keys `appUrl` and
// `dbBackup.scheduleEnabled` (`DB_BACKUP_SCHEDULE_ENABLED !== 'false'`, same
// meaning as before; read from `config/configuration.ts`, so no option is passed).
//
// The `databaseBackup` namespace and the `database-backups/` key prefix are
// registered by `settings/registry/` and `platform/storage/storage-key-prefix.manifest.ts`.
// The restore gate `<APP_SLUG>-extensions` is registered by `app-registrations/db-backup.ts`
// (imported by `app-registrations/registrations.ts`, before the registries freeze).
// The notification events and the browser renderers stay in
// `notifications-registry/db-backup.notifications.ts`.
// =============================================================================

import { APP_NAME } from '@app/shared';
import { DbBackupModule } from '@marinoscar/platform-api/db-backup';

import { DbBackupHostModule } from './db-backup-host.module';

export const dbBackupModule = DbBackupModule.forRoot({
  appName: APP_NAME,
  imports: [DbBackupHostModule],
});
