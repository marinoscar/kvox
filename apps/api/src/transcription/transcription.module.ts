import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { SettingsModule } from '../settings/settings.module';
import { AssemblyAiProvider } from './providers/assemblyai.provider';
import { TranscriptionConfigController } from './transcription-config.controller';
import { TranscriptionConfigService } from './transcription-config.service';
import { TranscriptionProviderRegistry } from './transcription-provider.registry';
import { TranscriptionSettingsController } from './transcription-settings.controller';
import { TranscriptionSettingsService } from './transcription-settings.service';

// =============================================================================
// TranscriptionModule (issue #23, epic #19)
// =============================================================================
//
// The provider framework, the providers themselves, and the two admin/config
// surfaces over them. Issue #25 adds the job handler that actually submits
// audio; it imports this module for the registry and the settings service and
// changes nothing here.
//
// EVERY PROVIDER IS REGISTERED UNCONDITIONALLY, not chosen here from the
// configured `provider` setting — exactly as `EmailModule` registers both SES
// and SMTP. Provider selection is a per-job, RUNTIME decision: the setting lives
// in the database and an administrator can change it without a restart, so a
// module-construction-time choice would be stale the moment they did. Providers
// are cheap to instantiate (none opens a socket or reads a credential until its
// first call), so registering all of them and letting the settings pick costs
// nothing and keeps the choice where it can respond to a settings change.
//
// NOT @Global(). `TranscriptionSettingsService` depends transitively on
// `CredentialsService.getSecret`, which returns plaintext; the set of modules
// that can reach it should stay a list a person can read, which means every
// consumer writes `imports: [TranscriptionModule]` and shows up in a diff.
// =============================================================================

@Module({
  imports: [
    // The `global` system_settings row (reads) and `audit_events` (writes).
    PrismaModule,
    // The provider API keys. Imported explicitly — `CredentialsModule` is
    // deliberately not global — so this module's access to a
    // plaintext-returning service is visible right here.
    CredentialsModule,
    // `SystemSettingsService`, which owns the `global` row's merge, validation,
    // unknown-key preservation and version counter. This module NEVER writes
    // that row directly; `DbBackupModule` takes the same dependency for the
    // same reason.
    SettingsModule,
  ],
  controllers: [TranscriptionSettingsController, TranscriptionConfigController],
  providers: [
    TranscriptionProviderRegistry,
    TranscriptionSettingsService,
    TranscriptionConfigService,
    AssemblyAiProvider,
  ],
  // The registry and the settings service are what #25's job handler needs:
  // one to resolve the configured provider, the other to read the policy and
  // the credential.
  exports: [
    TranscriptionProviderRegistry,
    TranscriptionSettingsService,
    // ⚠ ADDED BY #274, AND FOR THE NARROW REASON EXPORTS IN THIS REPOSITORY ARE
    // ADDED FOR: somebody now imports it. It was previously withheld as "one
    // projection for one endpoint in this module", which stopped being true the
    // moment a second surface had to answer the same question.
    //
    // The onboarding checklist has to report whether this deployment can
    // transcribe at all, and that is the four-fact conjunction this service's
    // header describes (enabled, a provider chosen, that provider registered in
    // THIS build, a key stored for it). Re-deriving it inside the onboarding
    // module from `TranscriptionSettingsService` + the registry would be a
    // second implementation of `available` — which could then report the
    // feature ready on a deployment whose own capability probe, and therefore
    // whose upload button, calls it unavailable. It resolves no credential and
    // returns no configuration detail, so exporting it widens nothing.
    TranscriptionConfigService,
  ],
})
export class TranscriptionModule {}
