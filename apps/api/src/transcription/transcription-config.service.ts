import { Injectable } from '@nestjs/common';

import { CredentialsService } from '../credentials/credentials.service';
import { TranscriptionProviderRegistry } from './transcription-provider.registry';
import { TranscriptionSettingsService } from './transcription-settings.service';
import {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  transcriptionCredentialName,
} from './transcription-credential.constants';
import type { TranscriptionConfigResponse } from './dto/transcription-settings.dto';

// =============================================================================
// TranscriptionConfigService (issue #23, epic #19)
// =============================================================================
//
// Answers ONE question for a non-admin client: "may I offer transcription, and
// what may I hand it?" — the capability, never the configuration behind it.
// See `dto/transcription-settings.dto.ts`'s `transcriptionConfigSchema` for why
// that distinction is the whole design, and
// `notifications/dto/notification-config.dto.ts` for the precedent.
//
// -----------------------------------------------------------------------------
// `available` IS A CONJUNCTION OF FOUR FACTS, AND ALL FOUR ARE NECESSARY
// -----------------------------------------------------------------------------
//
//   1. the master switch is on;
//   2. a provider has been chosen;
//   3. that provider is REGISTERED IN THIS BUILD — a deployment that rolled
//      back across the addition of a provider has a settings row naming one
//      this process has never heard of, and reporting `available: true` would
//      let a user upload a file for a vendor nothing can submit to;
//   4. an API KEY IS STORED for it — the single most common half-finished
//      state, because choosing a provider and pasting its key are two fields
//      and people save between them.
//
// Reporting anything less than all four as "available" moves the failure from
// a disabled button to a failed job minutes later, which is the difference
// between "transcription is not set up" and "transcription is broken".
//
// THE KEY'S EXISTENCE IS CHECKED WITH `describe`, NEVER `getSecret`. This runs
// on a request any signed-in user can make; a path that decrypts a credential
// to answer a capability question is a path one careless `return` away from
// publishing it. `describe` does not even select the ciphertext column.
// =============================================================================

/**
 * MIME type → file extensions, for populating a file picker's `accept`.
 *
 * A LOOKUP TABLE RATHER THAN A LIBRARY: the set is small, stable, and the
 * generic mappings a `mime` package returns are wrong for exactly the cases
 * that matter here (`audio/mpeg` → `.mpga`, which no user has ever seen on a
 * file). Anything not in this table contributes no extension — the MIME type
 * is still published, so a picker can use that instead.
 */
const MIME_EXTENSIONS: Record<string, string[]> = {
  'audio/mpeg': ['.mp3'],
  'audio/mp3': ['.mp3'],
  'audio/mp4': ['.m4a', '.mp4'],
  'audio/m4a': ['.m4a'],
  'audio/x-m4a': ['.m4a'],
  'audio/aac': ['.aac'],
  'audio/wav': ['.wav'],
  'audio/x-wav': ['.wav'],
  'audio/webm': ['.webm'],
  'audio/ogg': ['.ogg', '.oga'],
  'audio/flac': ['.flac'],
  'audio/x-flac': ['.flac'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
};

/** What an unusable deployment reports. Every number zero, every list empty. */
const UNAVAILABLE: TranscriptionConfigResponse = {
  available: false,
  providerLabel: null,
  maxUploadBytes: 0,
  maxDurationMs: 0,
  acceptedExtensions: [],
  acceptedMimeTypes: [],
};

@Injectable()
export class TranscriptionConfigService {
  constructor(
    private readonly settings: TranscriptionSettingsService,
    private readonly registry: TranscriptionProviderRegistry,
    private readonly credentials: CredentialsService,
  ) {}

  /**
   * The capability answer.
   *
   * NEVER THROWS FOR AN UNCONFIGURED DEPLOYMENT — "nothing is set up" is the
   * normal state of a fresh installation and is reported as `available: false`,
   * not as an error. A client asking "may I offer this?" and getting a 500 has
   * learned nothing it can act on.
   */
  async getConfig(): Promise<TranscriptionConfigResponse> {
    const policy = await this.settings.get();

    if (!policy.enabled || !policy.provider) return UNAVAILABLE;

    const provider = this.registry.get(policy.provider);

    // Fact 3: a settings row naming a provider this build does not have. See
    // the header — this is what a rollback across a provider addition looks
    // like, and it must read as unavailable rather than as a promise nothing
    // can keep.
    if (!provider) return UNAVAILABLE;

    // Fact 4: is a key stored? `describe`, never `getSecret` — see the header.
    const key = await this.credentials.describe(
      TRANSCRIPTION_CREDENTIAL_PURPOSE,
      transcriptionCredentialName(policy.provider),
    );

    if (!key) {
      // A CHOSEN PROVIDER WITH NO KEY still reports the provider's limits.
      // Deliberately: a client rendering a disabled control can say what it
      // would allow, and an administrator reading the same payload sees the
      // configuration is half-finished rather than absent.
      return {
        ...this.describeProviderLimits(provider),
        available: false,
      };
    }

    return {
      ...this.describeProviderLimits(provider),
      available: true,
    };
  }

  /** The provider's published limits, without the availability verdict. */
  private describeProviderLimits(
    provider: { label: string; capabilities: { maxInputBytes: number; maxDurationMs: number; acceptedMimeTypes: string[] } },
  ): Omit<TranscriptionConfigResponse, 'available'> {
    const mimeTypes = provider.capabilities.acceptedMimeTypes.map((type) =>
      type.toLowerCase(),
    );

    // De-duplicated because several MIME types map to the same extension
    // (`audio/mpeg` and `audio/mp3` both give `.mp3`), and a repeated entry in
    // an `accept` attribute is noise a user can see in the file dialog.
    const extensions = [
      ...new Set(mimeTypes.flatMap((type) => MIME_EXTENSIONS[type] ?? [])),
    ];

    return {
      providerLabel: provider.label,
      maxUploadBytes: provider.capabilities.maxInputBytes,
      maxDurationMs: provider.capabilities.maxDurationMs,
      acceptedExtensions: extensions,
      acceptedMimeTypes: mimeTypes,
    };
  }
}
