import { Module } from '@nestjs/common';
import { CredentialsModule } from '@marinoscar/platform-api/credentials';

import { TranscriptionConfig } from './transcription.config';
import { TranscriptionConfiguredDoctorCheck } from './transcription-configured.doctor-check';

/**
 * The parts of transcription that use the platform and so cannot live in the
 * package: the Doctor check `<slug>.transcription.configured`, which registers
 * itself with the platform `DoctorCheckRegistry` when this module starts.
 *
 * It imports the configured slice for `TranscriptionSettingsService` and reads
 * whether a key exists through the platform `CredentialsService` (`describe`, never
 * the plaintext).
 */
@Module({
  // `CredentialsModule` is deliberately not global: the platform credential store is
  // imported where it is read, so this module's access to it is visible here.
  imports: [TranscriptionConfig, CredentialsModule],
  providers: [TranscriptionConfiguredDoctorCheck],
})
export class TranscriptionBindingModule {}
