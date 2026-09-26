import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { AiConfigController } from './ai-config.controller';
import { AiConfigService } from './ai-config.service';
import { AiCredentialsController } from './ai-credentials.controller';
import { AiModelDiscoveryService } from './ai-model-discovery.service';
import { AiProviderRegistry } from './ai-provider.registry';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiTaskModelResolver } from './ai-task-model-resolver.service';
import {
  OPENAI_FETCH,
  OpenAiProvider,
  type FetchLike,
} from './providers/openai.provider';
import { UserAiCredentialsService } from './user-ai-credentials.service';

// =============================================================================
// AiModule (issue #47, epic #45)
// =============================================================================
//
// The AI provider framework, the providers themselves, the deployment policy
// surface, the per-user credential surface, and the capability probe over all
// of it. Issues #49-#53 add the generation pipeline; they import this module
// for the registry, the policy and `UserAiCredentialsService`, and change
// nothing here.
//
// EVERY PROVIDER IS REGISTERED UNCONDITIONALLY, not chosen here from a setting
// — exactly as `TranscriptionModule` and `EmailModule` do. Provider selection
// is a RUNTIME decision: the setting lives in the database and an administrator
// can change it without a restart, so a module-construction-time choice would
// be stale the moment they did. Providers are cheap (none opens a socket or
// reads a credential until its first call).
//
// ⚠ NO `CredentialsModule` IMPORT, AND THAT ABSENCE IS DELIBERATE. Every other
// module that handles a secret takes that dependency; this one does not,
// because there is no deployment AI key to fetch. The per-user keys live in
// `user_ai_credentials` behind a cascading foreign key and are reached only
// through `UserAiCredentialsService`, which does its own `encryptSecret`/
// `decryptSecret` with a purpose of its own. See that service's header for why
// the shared credential table was the wrong home.
//
// NOT @Global(), matching `TranscriptionModule`'s reasoning and for a stronger
// version of its reason: `UserAiCredentialsService.getSecret` returns the
// plaintext of somebody's PERSONAL credential, so the set of modules that can
// reach it must stay a list a person can read — which means every consumer
// writes `imports: [AiModule]` and shows up in a diff.
// =============================================================================

@Module({
  imports: [
    // The `global` system_settings row (reads), `user_ai_credentials` and
    // `audit_events` (writes).
    PrismaModule,
    // `SystemSettingsService`, which owns the `global` row's merge, validation,
    // unknown-key preservation and version counter. This module NEVER writes
    // that row directly; `TranscriptionModule` and `DbBackupModule` take the
    // same dependency for the same reason.
    SettingsModule,
  ],
  controllers: [
    AiSettingsController,
    AiCredentialsController,
    AiConfigController,
  ],
  providers: [
    AiProviderRegistry,
    AiSettingsService,
    UserAiCredentialsService,
    AiConfigService,
    // #78. A LEAF, exactly like `AiConfigService` beside it: it composes the
    // policy, the registry and the per-user credential service, and none of the
    // three knows it exists. That is what keeps `GET /api/ai-settings/models`
    // out of a `forwardRef` cycle with `UserAiCredentialsService`, which
    // already injects `AiSettingsService` — see the service's own header.
    AiModelDiscoveryService,
    // #360. The one run-time model resolver: notes generation and every
    // connected-knowledge task resolve provider + model through it.
    AiTaskModelResolver,
    // ⚠ THE `fetch` SEAM IS REGISTERED HERE, unlike `ASSEMBLYAI_FETCH` which
    // exists only as an `@Optional()` constructor default. The difference is
    // not stylistic: `Test.createTestingModule(...).overrideProvider(token)` is
    // a NO-OP for a token no module registers, so an unregistered seam can be
    // replaced by a unit test constructing the provider by hand but NOT by an
    // integration spec booting the real `AppModule` — which is exactly the spec
    // that most needs it, since `POST /api/ai-credentials/test` would otherwise
    // make a real outbound request to OpenAI from CI.
    //
    // The default is still the bound global `fetch`, and `OpenAiProvider`'s
    // `@Optional()` parameter default is still there, so constructing the
    // provider directly (as `openai.provider.spec.ts` does) keeps working.
    {
      provide: OPENAI_FETCH,
      // Bound to `globalThis`: an unbound `fetch` reference throws
      // `Illegal invocation` in some runtimes, and the failure looks like a
      // network error rather than like the mistake it is.
      useValue: ((input: string, init?: unknown) =>
        globalThis.fetch(input, init as RequestInit)) as unknown as FetchLike,
    },
    OpenAiProvider,
  ],
  // What the generation pipeline (#49 onwards) needs: the registry to resolve
  // the configured provider, the settings service to read the policy, and the
  // credential service to resolve the calling user's own key at the moment of
  // use. The config service is deliberately NOT exported — it is one projection
  // for one endpoint in this module.
  exports: [
    AiProviderRegistry,
    AiSettingsService,
    UserAiCredentialsService,
    // ⚠ ADDED BY #50, AND FOR THE NARROW REASON THAT EXPORTS IN THIS REPOSITORY
    // ARE ADDED FOR: somebody now imports it. `POST /api/note-templates/preview`
    // has to answer the same two questions `GET /api/ai/config` answers — is
    // this deployment able to generate at all, and does THIS caller have a key —
    // before it queues a real, billable generation. Re-deriving that from
    // `AiSettingsService` + the registry inside the notes module would be a
    // second implementation of the four-fact `available` conjunction, which
    // could then report the feature usable on a deployment the config probe
    // (and therefore the UI) calls unavailable.
    AiConfigService,
    // #360: `NoteGenerationRequestService.resolveModel` delegates to it, and
    // every graph job (#363, #364, #372, #378) will.
    AiTaskModelResolver,
  ],
})
export class AiModule {}
