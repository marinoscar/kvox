import { Module } from '@nestjs/common';

import { AiUserKeysPurger } from '../platform/ai/ai-user-keys.purger';
import { PrismaModule } from '../prisma/prisma.module';
import { KvoxObjectsModule } from '../kvox-objects/kvox-objects.module';
import { UserDataPurgeHandler } from './handlers/user-data-purge.handler';
import { UserDataController } from './user-data.controller';
import {
  CREDENTIALS_USER_DATA_HOOKS,
  FILES_USER_DATA_HOOKS,
  ONBOARDING_USER_DATA_HOOKS,
} from './user-data.base';
import {
  CredentialsUserDataHooks,
  PatRevoker,
  FilesUserDataHooks,
  OnboardingUserDataHooks,
} from './user-data.base.hooks';
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
//   • `PrismaModule` — the audit rows, the base categories' counts and the
//     batched deletes of the plain-uploads step.
//   • `JobsModule` — `JobHandlerRegistry` for the handler to register itself
//     with, and `JobsService` to enqueue `user.data.purge`, whose partial
//     unique dedup index is the REAL enforcement of "one deletion at a time
//     per user" (see `UserDataService`'s header).
//   • `KvoxObjectsModule` — `ObjectsService.delete` (the platform's) and the
//     ownership-aware object reads for the caller's plain uploads.
//   • `AiUserKeysPurger` (provided below, not imported) — erases the user's AI
//     keys through the platform's `UserAiKeysService`, which deletes the row and
//     audits it. It resolves that service by `ModuleRef`, so this module names
//     the dependency in its provider list and imports nothing from the AI slice
//     (issue #475).
//   • `SettingsModule` — `UserSettingsService.patchSettings`, for the one
//     `user_settings` namespace `everything` clears: `onboarding`. The handler
//     hand-writes no JSONB edit; `{ onboarding: null }` is already the tested
//     operation that collapses that namespace back to ABSENT, which is how
//     "never onboarded" is spelled (epic #271). Same argument as the AI keys
//     above for naming it here rather than reaching for `prisma` directly —
//     except that this one is also the reason the import list is worth reading:
//     a module that can touch a user's settings row should say so.
//
// `PatRevoker` (PLATFORM-ADOPTION-SHIM(#465)) is provided here: the platform's
// `PatService` has no revoke-all, so the one `updateMany` it needs lives beside
// the hook that calls it.
//
// ⚠ IT IMPORTS NO DOMAIN MODULE (issue #460). The transcripts, notes, note
// templates, knowledge graph and Ask categories are declared by their own
// modules (`<domain>/<domain>.user-data.ts`), each hook class is PROVIDED by
// exactly one domain module under a string token
// (`{ provide: NOTES_USER_DATA_HOOKS, useClass: NotesUserDataHooks }`), and this
// module resolves them at run time with `ModuleRef.get(token, { strict: false })`
// — they are in the application graph through `AppModule`. `ModuleRef` returns
// the first instance it finds, which is why a token must be provided in one
// module only. A hook that cannot be resolved fails the job; it is never
// skipped. See `docs/specs/user-data-deletion.md` §8.
//
// ⚠ NO `forwardRef` ANYWHERE, and that is a property of the dependency
// direction rather than luck: nothing here imports a feature module, and no
// feature module imports this one.
//
// ⚠ REGISTERED LAST IN `app.module.ts`, after every module it resolves hooks
// from. Nest resolves providers regardless of order, but the list reads as a
// dependency order and this module genuinely sits at the bottom of it.
// =============================================================================

@Module({
  imports: [
    PrismaModule,
    KvoxObjectsModule,
    // Epic #271 — `UserSettingsService.patchSettings`, so the `everything`
    // scope can clear the `onboarding` namespace through the path that already
    // knows how an emptied namespace collapses back to absent.
  ],
  controllers: [UserDataController],
  providers: [
    UserDataService,
    UserDataPurgeHandler,
    // The base categories' hooks (`user-data.base.ts`). The domain categories'
    // hooks are provided by their own modules.
    { provide: FILES_USER_DATA_HOOKS, useClass: FilesUserDataHooks },
    PatRevoker,
    AiUserKeysPurger,
    { provide: CREDENTIALS_USER_DATA_HOOKS, useClass: CredentialsUserDataHooks },
    { provide: ONBOARDING_USER_DATA_HOOKS, useClass: OnboardingUserDataHooks },
  ],
  exports: [UserDataService],
})
export class UserDataModule {}
