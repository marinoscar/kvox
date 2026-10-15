import { Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  transcriptionCredentialName,
} from './transcription-credential.constants';
import { TranscriptionSettingsService } from './transcription-settings.service';

// =============================================================================
// Doctor check: transcription is configured (issue #464)
// =============================================================================
//
// Warns (never fails: a deployment without speech-to-text is a valid one) when
// no provider is selected, or when the selected provider has no stored API key.
//
// A PRESENCE CHECK ONLY. It reads the `transcription` system settings namespace
// and asks the credential store whether a key EXISTS (`describe`, which returns a
// type that cannot carry secret material). It never decrypts a key, never calls
// the provider and never writes. The details name the provider id and two
// booleans, nothing else.
//
// LIVES IN THIS FOLDER, NOT IN `doctor/checks/`: base code does not import domain
// code (`test/architecture/base-domain-boundary.spec.ts`), and this check reads
// the transcription credential purpose. `TranscriptionModule` provides it, so
// being in the module graph is its registration.
// =============================================================================

/** The slice of the `transcription` namespace this check reads. */
export interface TranscriptionPolicyFacts {
  enabled: boolean;
  provider: string | null;
}

/** The rule, separated from the reads so a test can drive it without a database. */
export function decideTranscriptionConfigured(
  policy: TranscriptionPolicyFacts,
  keyStored: boolean,
): DoctorCheckOutcome {
  if (!policy.provider) {
    return {
      status: 'warn',
      detail: 'No transcription provider is configured, so transcripts cannot be created',
      remedy: 'Choose a provider and store its API key under Admin settings, Transcription.',
      data: { provider: null, keyStored: false, enabled: policy.enabled },
    };
  }

  const data = { provider: policy.provider, keyStored, enabled: policy.enabled };

  if (!keyStored) {
    return {
      status: 'warn',
      detail: `Transcription provider "${policy.provider}" is selected but has no stored API key`,
      remedy: 'Store the provider API key under Admin settings, Transcription.',
      data,
    };
  }

  return {
    status: 'pass',
    detail: policy.enabled
      ? `Transcription provider "${policy.provider}" is configured with a stored API key`
      : `Transcription provider "${policy.provider}" is configured but transcription is switched off`,
    data,
  };
}

@Injectable()
export class TranscriptionConfiguredDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = `${APP_SLUG}.transcription.configured`;
  readonly category = 'ai';
  readonly label = 'Transcription provider';
  readonly settingsPath = '/admin/settings/transcription';
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly settings: TranscriptionSettingsService,
    private readonly credentials: CredentialsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const policy = await this.settings.get();
    const provider = policy.provider ?? null;

    const info = provider
      ? await this.credentials.describe(
          TRANSCRIPTION_CREDENTIAL_PURPOSE,
          transcriptionCredentialName(provider),
        )
      : null;

    return decideTranscriptionConfigured(
      { enabled: policy.enabled === true, provider },
      info !== null,
    );
  }
}
