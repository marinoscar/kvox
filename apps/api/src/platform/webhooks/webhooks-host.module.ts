// =============================================================================
// The app's binding of the webhooks slice's host ports (#795)
// =============================================================================
//
//   WEBHOOKS_SYSTEM_PRISMA  PrismaSystemService: the bypass client. A
//                           system-scope endpoint (and its deliveries) has no
//                           organization, so row-level security shows it to the
//                           bypass client only. Reasons `webhooks` (every
//                           system-scope query and the delivery job's reads of
//                           them) and `retention` (the delivery purge across
//                           organizations).
//
// PLATFORM_PRISMA, AUDIT_SINK, JobsService, the credential stores and the
// notifications come from the app's global modules.
// =============================================================================

import { Module } from '@nestjs/common';
import { WEBHOOKS_SYSTEM_PRISMA } from '@marinoscar/platform-api/webhooks';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

@Module({
  providers: [{ provide: WEBHOOKS_SYSTEM_PRISMA, useExisting: PrismaSystemService }],
  exports: [WEBHOOKS_SYSTEM_PRISMA],
})
export class WebhooksHostModule {}
