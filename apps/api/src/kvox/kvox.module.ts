import { Module } from '@nestjs/common';

import { platformKvoxModule } from '../platform-kvox/platform-kvox.module';
import { TranscriptionBindingModule } from './transcription/transcription-binding.module';
import { TranscriptionConfig } from './transcription/transcription.config';

// =============================================================================
// KvoxModule (issue #492, epic #491)
// =============================================================================
//
// The one module `app.module.ts` imports for the domain. It imports the
// web edition's binding of the host ports (`PlatformKvoxModule`, global) FIRST,
// then the configuration of each `@marinoscar/kvox-api` slice
// (`<slice>/<slice>.config.ts`, the only place the application configures it),
// then the pieces of a slice that use the platform and so stay in the application.
//
// After SettingsModule, CredentialsModule and the identity slice in
// `app.module.ts`: the ports' adapters inject their services. A missing port
// binding stops the boot.
//
// Later slices (transcripts, search, notes, graph, Ask) append their config to
// this list as they move into the package.
// =============================================================================

@Module({
  imports: [
    platformKvoxModule,
    TranscriptionConfig,
    TranscriptionBindingModule,
  ],
})
export class KvoxModule {}
