// =============================================================================
// The storage slice's host ports (issue #469, epic #467)
// =============================================================================
//
//   STORAGE_SYSTEM_DATA -> PrismaSystemService.forSystem
//
// The bypass client behind the four cross-organization paths of the slice: the
// stale-upload sweep, the stranded-object count of the provider-switch gate,
// the public avatar route and the avatar replacement across an org switch. It
// is a SEPARATE connection pool (every transaction sets `app.rls_bypass`); this
// file is the only binding of it.
//
// `@Global()` so the slice's services resolve the port from whichever module
// instantiates them. `PLATFORM_PRISMA` is bound by `platform-host.module.ts`.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { STORAGE_SYSTEM_DATA } from '@marinoscar/platform-api/storage';
import type { StorageSystemData } from '@marinoscar/platform-api/storage';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_SYSTEM_DATA,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): StorageSystemData => ({
        asSystem: (reason) => system.forSystem(reason) as unknown as ReturnType<StorageSystemData['asSystem']>,
      }),
    },
  ],
  exports: [STORAGE_SYSTEM_DATA],
})
export class StorageHostModule {}
