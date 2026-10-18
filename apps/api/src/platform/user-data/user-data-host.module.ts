import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { runAsSystem } from '@marinoscar/platform-api/core';
import { STORAGE_PROVIDER, StorageProvidersModule, type StorageProvider } from '@marinoscar/platform-api/storage';
import { USER_DATA_DB } from '@marinoscar/platform-api/user-data';
import type { UserDataDbPort, UserDataSystemReason } from '@marinoscar/platform-api/user-data';

import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { bindKvoxFactoryResetDeps } from '../../kvox-objects/factory-reset-storage.step';
import { KvoxOrgOffboardBinding } from './offboarding.steps';

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
//
// It also hands this app's factory reset storage sweep (`factory-reset.steps.ts`) the two
// ports a registered step function cannot inject: this bypass client and the active storage
// provider (issue #562). `KvoxOrgOffboardBinding` installs this app's organization offboarding
// steps on the platform's `org.offboard` handler (`offboarding.steps.ts`, issue #568).
// =============================================================================

/** Binds the storage sweep's ports once the container is up. */
@Injectable()
export class KvoxFactoryResetBinding implements OnModuleInit {
  constructor(
    @Inject(USER_DATA_DB) private readonly db: UserDataDbPort,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  onModuleInit(): void {
    bindKvoxFactoryResetDeps({ db: this.db, storage: this.storage });
  }
}

@Module({
  imports: [StorageProvidersModule],
  providers: [
    KvoxFactoryResetBinding,
    KvoxOrgOffboardBinding,
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
