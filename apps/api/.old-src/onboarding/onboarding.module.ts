import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminOnboardingController } from './admin-onboarding.controller';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

// =============================================================================
// OnboardingModule (issues #274 and #275, epic #271)
// =============================================================================
//
// Two read-only routes over one registry: `GET /api/onboarding` (the caller's
// own activation checklist, no permission string) and `GET /api/admin/onboarding`
// (this deployment's setup checklist, `system_settings:read`). Both controllers
// live here — the two prefixes are what keeps the admin-only reads on a code
// path a non-admin request cannot reach, and separating the module as well
// would only duplicate the imports below.
//
// -----------------------------------------------------------------------------
// EVERY IMPORT IS A READINESS FACT THIS MODULE REFUSES TO RE-DERIVE
// -----------------------------------------------------------------------------
//
// That is the whole reason the import list is this long, and it is the list
// being long that is the point: each entry is a question ("can this deployment
// transcribe", "may it generate", "will mail go out") that already has exactly
// one implementation somewhere else, complete with the conjunctions and edge
// cases that implementation's header argues for. A checklist that answered any
// of them itself would eventually disagree with the feature it describes —
// green over a disabled button — and the disagreement would be invisible until
// a user reported it.
//
// So: `AiModule` for the per-caller `AiConfigService`, `SettingsModule` for the AI and backup
// policies plus the caller's own settings, `EmailModule` and
// `NotificationsModule` for the two admin-only `describeForAdmin` views.
// `PrismaService` needs no import — `PrismaModule` is `@Global` — and is used
// only for the two admin account counts.
//
// NO DOMAIN MODULE IS IMPORTED (issue #460). What transcription, transcripts and
// notes contribute — their steps and the facts behind them — is declared beside
// those modules and registered from `kvox.manifest.ts`; the service resolves a
// fact's provider with `ModuleRef.get(token, { strict: false })`, which finds it
// anywhere in the application graph. So `TranscriptionModule` is no longer here.
//
// NOTHING IS EXPORTED. No other module has a reason to ask this one anything,
// and #272's persisted intent (`onboarding.skipped[]`) is owned by
// `UserSettingsService`, not by this module — the epic's skip/dismiss writes go
// through `PATCH /api/user-settings` rather than through a route here.
// =============================================================================

@Module({
  imports: [
    AiModule,
    EmailModule,
    NotificationsModule,
  ],
  controllers: [OnboardingController, AdminOnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
