// =============================================================================
// The sharing slice's host ports (issue #485, epic #478)
// =============================================================================
//
//   SHARING_DATA           -> sharing-data.adapter.ts   (`PrismaService.runInOrg`, the bypass client)
//   SHARING_EVENT_BUS      -> EVENT_BUS                 (the host core's cross-replica bus)
//   SHARING_EVENT_EMITTER  -> EventEmitter2             (the app's in-process emitter)
//   SHARING_NOTIFIER       -> sharing-notifier.adapter.ts (`NotificationsService`)
//   SHARING_TENANCY        -> `single`                  (this app runs one organization)
//   SHARING_JOBS           -> sharing-jobs.adapter.ts   (the platform job queue, for `sharing.grants.prune`)
//
// NOT @Global: `SharingModule.forRoot({ imports: [SharingHostModule] })` is the only
// consumer, and the sharing tables are under forced row-level security, so the
// bypass client (`runAsSystem`) is kept as close to the slice as possible.
// =============================================================================

import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EVENT_BUS } from '@marinoscar/platform-api/host';
import {
  SHARING_DATA,
  SHARING_EVENT_BUS,
  SHARING_EVENT_EMITTER,
  SHARING_JOBS,
  SHARING_NOTIFIER,
  SHARING_TENANCY,
} from '@marinoscar/platform-api/sharing';
import type { SharingTenancy } from '@marinoscar/platform-api/sharing';

import { SharingDataAdapter } from './sharing-data.adapter';
import { SharingJobsAdapter } from './sharing-jobs.adapter';
import { SharingNotifierAdapter } from './sharing-notifier.adapter';

const SINGLE_TENANCY: SharingTenancy = { mode: () => 'single' };

@Module({
  providers: [
    { provide: SHARING_DATA, useClass: SharingDataAdapter },
    { provide: SHARING_EVENT_BUS, useExisting: EVENT_BUS },
    { provide: SHARING_EVENT_EMITTER, useExisting: EventEmitter2 },
    { provide: SHARING_NOTIFIER, useClass: SharingNotifierAdapter },
    { provide: SHARING_TENANCY, useValue: SINGLE_TENANCY },
    { provide: SHARING_JOBS, useClass: SharingJobsAdapter },
  ],
  exports: [
    SHARING_DATA,
    SHARING_EVENT_BUS,
    SHARING_EVENT_EMITTER,
    SHARING_NOTIFIER,
    SHARING_TENANCY,
    SHARING_JOBS,
  ],
})
export class SharingHostModule {}
