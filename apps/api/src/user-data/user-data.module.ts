import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { JobsModule } from '../jobs/jobs.module';
import { NotesModule } from '../notes/notes.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SearchIndexingModule } from '../search/indexing/search-indexing.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { TranscriptsModule } from '../transcripts/transcripts.module';
import { UserDataPurgeHandler } from './handlers/user-data-purge.handler';
import { UserDataController } from './user-data.controller';
import { UserDataService } from './user-data.service';

// =============================================================================
// UserDataModule (issue #80) — the Danger Zone
// =============================================================================
//
// Bulk deletion of a user's OWN data: the inventory they decide from, the
// request that queues it, and the job that performs it.
//
// WHAT IT IMPORTS, AND WHY EACH ONE:
//
//   • `PrismaModule` — every count and aggregate in the summary, the audit
//     rows, and the batched soft-deletes and link-clearing `user.data.purge`
//     performs.
//   • `JobsModule` — `JobHandlerRegistry` for the handler to register itself
//     with, and `JobsService` to enqueue `user.data.purge`, whose partial
//     unique dedup index is the REAL enforcement of "one deletion at a time
//     per user" (see `UserDataService`'s header).
//   • `NotesModule` — `NotesService.enqueuePurge` and
//     `NoteTemplatesService.remove`. The handler deletes no note bytes itself.
//   • `TranscriptsModule` — `TranscriptPipelineService.enqueuePurge`, likewise.
//   • `StorageModule` — `ObjectsService.delete` for the caller's plain uploads.
//   • `AiModule` — `UserAiCredentialsService.removeAll`. Deliberately NOT
//     `@Global()`, so it has to be imported by name, which is the point: a
//     module that can erase a user's encrypted keys should say so in its own
//     import list.
//   • `SettingsModule` — `UserSettingsService.patchSettings`, for the one
//     `user_settings` namespace `everything` clears: `onboarding`. The handler
//     hand-writes no JSONB edit; `{ onboarding: null }` is already the tested
//     operation that collapses that namespace back to ABSENT, which is how
//     "never onboarded" is spelled (epic #271). Same argument as `AiModule`
//     above for naming it here rather than reaching for `prisma` directly —
//     except that this one is also the reason the import list is worth reading:
//     a module that can touch a user's settings row should say so.
//
// `PatModule` is absent from this list and `PatService` is nevertheless
// injected: that module is `@Global()`, so importing it again would be a second
// declaration of a provider Nest already resolves everywhere.
//
// ⚠ NO `forwardRef` ANYWHERE, and that is a property of the dependency
// direction rather than luck: this module imports the feature modules, and none
// of them imports it. `SettingsModule` is the newest and the cheapest check of
// all: it declares NO `imports` at all (its two services reach Prisma through
// the global `PrismaModule`), so it cannot reach back here even transitively. Nothing in `notes`, `transcripts`, `storage`, `ai` or
// `pat` needs to know a bulk-deletion surface exists — it reuses their public
// services and registers no callback into itself. If a future change makes one
// of them depend on this module, the fix is to move the shared piece down, not
// to add a `forwardRef` that hides a cycle the runtime still has to resolve.
//
// ⚠ REGISTERED LAST IN `app.module.ts`, after every module it imports. Nest
// resolves providers regardless of order, but the list reads as a dependency
// order and this module genuinely sits at the bottom of it.
// =============================================================================

@Module({
  imports: [
    PrismaModule,
    JobsModule,
    NotesModule,
    TranscriptsModule,
    StorageModule,
    AiModule,
    // Epic #271 — `UserSettingsService.patchSettings`, so the `everything`
    // scope can clear the `onboarding` namespace through the path that already
    // knows how an emptied namespace collapses back to absent.
    SettingsModule,
    // #188, epic #165 — `SearchIndexService.forgetOwnerDocuments`. A bulk
    // deletion clears the semantic index for every category it destroys rather
    // than trusting the per-item purge jobs it queued to get there; see the
    // handler's `forgetFromSearchIndex`.
    SearchIndexingModule,
  ],
  controllers: [UserDataController],
  providers: [UserDataService, UserDataPurgeHandler],
  exports: [UserDataService],
})
export class UserDataModule {}
