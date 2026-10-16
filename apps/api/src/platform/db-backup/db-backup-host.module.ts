// =============================================================================
// The database backup slice's host ports (issue #471, epic #467)
// =============================================================================
//
//   DB_BACKUP_NOTIFIER        -> NotificationsService     (the platform dispatcher, #470)
//   DB_BACKUP_MAINTENANCE     -> MaintenanceModeService   (the host core's in-memory override)
//   DB_BACKUP_METRICS         -> AppMetricsService        (`app.backup.*`, the host core's)
//   DB_BACKUP_DEPLOYMENT_MODE -> DeploymentModeService    (`DEPLOYMENT_MODE`; `saas` turns restore off)
//   DB_BACKUP_SYSTEM_DATA     -> PrismaSystemService      (the bypass client, for the Doctor's
//                                                          `backup.rls-bypass` check only)
//
// Every one of them is a provider the host core or the notifications slice already
// exports globally, so the bindings are `useExisting`. The system-data binding is
// the one adapter: the platform wants `runAsSystem(reason, fn)` and this app's
// bypass client exposes `forSystem(reason)`, so the adapter calls core's
// `runAsSystem` over it.
//
// `@Global()` so the slice's services resolve the ports from whichever module
// instantiates them (the same arrangement as the jobs and notifications hosts).
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { runAsSystem } from '@marinoscar/platform-api/core';
import {
  DB_BACKUP_DEPLOYMENT_MODE,
  DB_BACKUP_MAINTENANCE,
  DB_BACKUP_METRICS,
  DB_BACKUP_NOTIFIER,
  DB_BACKUP_SYSTEM_DATA,
} from '@marinoscar/platform-api/db-backup';
import type { DbBackupSystemData, DbBackupSystemTx } from '@marinoscar/platform-api/db-backup';
import {
  AppMetricsService,
  DeploymentModeService,
  MaintenanceModeService,
} from '@marinoscar/platform-api/host';
import { NotificationsService } from '@marinoscar/platform-api/notifications';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

@Global()
@Module({
  providers: [
    { provide: DB_BACKUP_NOTIFIER, useExisting: NotificationsService },
    { provide: DB_BACKUP_MAINTENANCE, useExisting: MaintenanceModeService },
    { provide: DB_BACKUP_METRICS, useExisting: AppMetricsService },
    { provide: DB_BACKUP_DEPLOYMENT_MODE, useExisting: DeploymentModeService },
    {
      provide: DB_BACKUP_SYSTEM_DATA,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): DbBackupSystemData => ({
        runAsSystem: <T>(reason: 'doctor', fn: (tx: DbBackupSystemTx) => Promise<T>): Promise<T> =>
          runAsSystem(system as never, reason, fn as never) as Promise<T>,
      }),
    },
  ],
  exports: [
    DB_BACKUP_NOTIFIER,
    DB_BACKUP_MAINTENANCE,
    DB_BACKUP_METRICS,
    DB_BACKUP_DEPLOYMENT_MODE,
    DB_BACKUP_SYSTEM_DATA,
  ],
})
export class DbBackupHostModule {}
