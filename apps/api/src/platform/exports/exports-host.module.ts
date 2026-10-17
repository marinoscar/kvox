// =============================================================================
// The exports slice's host ports (issue #532, epic #479)
// =============================================================================
//
//   EXPORTS_SYSTEM_DATA -> PrismaSystemService             (the bypass client, `asSystem(reason)`)
//   EXPORTS_NOTIFIER    -> exports-notifier.adapter.ts      (`NotificationsService`)
//
// `EXPORTS_SYSTEM_DATA` is the SEPARATE client on its own pool that the platform's
// `app.rls_bypass` flag rides on; the ordinary `PrismaService` never carries it. The slice
// reads a user's rows across organizations through it (`export`), and the expiry deletes
// through it (`purge`); both reasons are built into the platform's access-reason registry,
// and every query the slice and the `kvox-content` source send names its owner explicitly,
// so lifting row-level security widens nothing.
//
// NOT @Global: `ExportsModule.forRoot({ imports: [ExportsHostModule] })` is the only
// consumer, which keeps the bypass client's reach narrow.
// =============================================================================

import { Module } from '@nestjs/common';
import { EXPORTS_NOTIFIER, EXPORTS_SYSTEM_DATA } from '@marinoscar/platform-api/exports';
import type { ExportsSystemData } from '@marinoscar/platform-api/exports';

import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { ExportsNotifierAdapter } from './exports-notifier.adapter';

@Module({
  providers: [
    {
      provide: EXPORTS_SYSTEM_DATA,
      inject: [PrismaSystemService],
      useFactory: (system: PrismaSystemService): ExportsSystemData => ({
        asSystem: (reason) => system.forSystem(reason) as never,
      }),
    },
    { provide: EXPORTS_NOTIFIER, useClass: ExportsNotifierAdapter },
  ],
  exports: [EXPORTS_SYSTEM_DATA, EXPORTS_NOTIFIER],
})
export class ExportsHostModule {}
