// =============================================================================
// This app's Doctor checks (issue #464, epic #462)
// =============================================================================
//
// Each check registers itself with the platform `DoctorCheckRegistry` in its own
// `onModuleInit`, so being in the module graph IS the registration. The checks
// are READ-ONLY: they select and describe, and never create, alter or write
// (`docs/specs/doctor.md` in the platform repository, section "Extending it").
//
// Only the checks that need no domain code are here. The transcription check
// (`<slug>.transcription.configured`) is provided by `TranscriptionModule`, beside
// the credential purpose it reads (base code does not import domain code).
// =============================================================================

import { Module } from '@nestjs/common';

import { DbExtensionsDoctorCheck } from './checks/db-extensions.doctor-check';

@Module({
  providers: [DbExtensionsDoctorCheck],
})
export class DoctorChecksModule {}
