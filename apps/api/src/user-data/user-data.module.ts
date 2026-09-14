import { Module } from '@nestjs/common';

import { JobsModule } from '../jobs/jobs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UserDataController } from './user-data.controller';
import { UserDataService } from './user-data.service';

// =============================================================================
// UserDataModule (issue #80) — the Danger Zone
// =============================================================================
//
// Bulk deletion of a user's OWN data: the inventory they decide from, the
// request that queues it, and (next) the job that performs it.
//
// WHAT IT IMPORTS, AND WHY:
//
//   • `PrismaModule` — every count and every aggregate in the summary, and the
//     audit row the request writes.
//   • `JobsModule` — `JobsService` to enqueue `user.data.purge`, whose partial
//     unique dedup index is the REAL enforcement of "one deletion at a time per
//     user" (see `UserDataService`'s header).
//
// ⚠ NO `forwardRef` ANYWHERE, and that is a property of the dependency
// direction rather than luck: this module imports the feature modules, and none
// of them imports it. Nothing in `notes`, `transcripts`, `storage`, `ai` or
// `pat` needs to know that a bulk-deletion surface exists — it reuses their
// public services and adds no callback into itself. If a future change makes
// one of them depend on this module, the fix is to move the shared piece down,
// not to add a `forwardRef` that hides a cycle the runtime still has to
// resolve.
// =============================================================================

@Module({
  imports: [PrismaModule, JobsModule],
  controllers: [UserDataController],
  providers: [UserDataService],
  exports: [UserDataService],
})
export class UserDataModule {}
