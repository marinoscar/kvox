// =============================================================================
// The database backup events (issues #288 and #470)
// =============================================================================
//
// `db_backup.backup_failed` and `db_backup.restore_completed`, raised to the
// holders of `db_backup:read` by `db-backup/` (this app's engine until
// #471 adopts the platform's). Their audience is a permission, not a person:
// whoever can act on a backup is told when one fails. The platform ships both
// email templates (`backup-failed`, `restore-completed`) and both browser
// renderers.
//
// THREE OF THE FOUR OPERATIONAL EVENTS ARE MUTEABLE AND ONE IS NOT: a failed
// backup is something an operator may watch elsewhere, but a COMPLETED RESTORE
// replaced the live database with an older copy of itself and everybody who can
// act on that must be told, whatever their preferences say.
// =============================================================================

import {
  backupFailedBrowserTemplate,
  restoreCompletedBrowserTemplate,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

export const DB_BACKUP_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: {
      key: 'db_backup.backup_failed',
      label: 'Database backup failed',
      description:
        'Sent when a database backup run fails, or stops heartbeating and is given up on. The deployment has one fewer recovery point than it thinks.',
      channels: ['email', 'browser'],
      defaultEnabled: true,
    },
    emailTemplate: 'backup-failed',
    browserTemplate: backupFailedBrowserTemplate,
  },

  {
    event: {
      key: 'db_backup.restore_completed',
      label: 'Database restored',
      description:
        'Sent when a database restore finishes and the restored copy becomes the live database. This cannot be turned off.',
      channels: ['email', 'browser'],
      defaultEnabled: true,
      // Silence is itself the risk: every write made after the archive was taken
      // is gone, and the process that did it exits immediately afterwards.
      mandatory: true,
    },
    emailTemplate: 'restore-completed',
    browserTemplate: restoreCompletedBrowserTemplate,
  },
];
