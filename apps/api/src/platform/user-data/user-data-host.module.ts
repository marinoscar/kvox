import { Module } from '@nestjs/common';
import { runAsSystem } from '@marinoscar/platform-api/core';
import { USER_DATA_DB } from '@marinoscar/platform-api/user-data';
import type { UserDataDbPort, UserDataSystemReason } from '@marinoscar/platform-api/user-data';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

// =============================================================================
// The user-data slice's one host port (issue #480)
// =============================================================================
//
// `USER_DATA_DB` is the bypass client the purge deletes through: the per-user
// purge removes rows across organizations' RLS-governed tables (storage objects
// among them), and the Danger Zone summary counts them. It is the app's
// `PrismaSystemService`, the SEPARATE client on its own pool that the platform's
// `app.rls_bypass` flag rides on; the ordinary `PrismaService` never carries it.
//
// The two reasons the slice uses are built into the platform's access-reason
// registry: `purge` (deleting) and `admin-aggregate` (the summary counts). Every
// statement the slice sends carries an explicit owner filter, so lifting row
// level security widens nothing: it lets the purge reach a user's rows in every
// organization, which is what "delete my data" means.
//
// Not @Global: only `UserDataModule.forRoot({ imports: [UserDataHostModule] })`
// needs it, and keeping the bypass client's reach narrow is the point.
// =============================================================================

@Module({
  providers: [
    {
      provide: USER_DATA_DB,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): UserDataDbPort => ({
        runAsSystem: <R>(
          reason: UserDataSystemReason,
          fn: (tx: unknown) => Promise<R>,
          options?: { timeout?: number },
        ): Promise<R> => runAsSystem(system as never, reason, fn as never, options) as Promise<R>,
        system: (reason: UserDataSystemReason) => system.forSystem(reason),
      }),
    },
  ],
  exports: [USER_DATA_DB],
})
export class UserDataHostModule {}
