import type { SystemTranscriptionValue } from '@marinoscar/kvox-contract/transcription';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcription` (issue #488, file `transcription/transcription-settings.schema.ts`); they are re-exported below so no importer changes.
export {
  TRANSCRIPTION_PROVIDER_IDS,
  transcriptionProviderIdSchema,
  type TranscriptionProviderId,
  ASSEMBLYAI_REGIONS,
  type AssemblyAiRegion,
  AUDIO_DELIVERY_MODES,
  type AudioDeliveryMode,
  transcriptionProvidersSchema,
  type TranscriptionProvidersValue,
  transcriptionPlaybackSchema,
  type TranscriptionPlaybackValue,
  systemTranscriptionSchema,
  type SystemTranscriptionValue,
  systemTranscriptionPatchSchema,
  type TranscriptionSettingsCarriesNoSecret,
  type AssemblyAiSettingsCarryNoSecret,
  TRANSCRIPTION_SETTINGS_CARRIES_NO_SECRET,
  ASSEMBLYAI_SETTINGS_CARRY_NO_SECRET,
} from '@marinoscar/kvox-contract/transcription';

/**
 * The value of the `transcription` namespace on a deployment nobody has
 * configured: switched off, no provider, AssemblyAI's `us` region.
 *
 * The slice declares the namespace with these defaults through
 * `KVOX_SETTINGS.registerNamespace`, and the web edition's settings manifest
 * reuses the same object, so "what does a fresh deployment do?" has one answer.
 *
 * @stability experimental
 */
export const TRANSCRIPTION_SETTINGS_DEFAULTS: SystemTranscriptionValue = {
  // INERT, like every operations default: `enabled: false` and `provider: null`
  // mean an upgrade changes nothing until an administrator chooses a vendor and
  // saves a key. The per-provider block is still fully populated, so choosing
  // AssemblyAI is one field rather than four.
  enabled: false,
  provider: null,
  providers: {
    assemblyai: {
      region: 'us',
      // A comma-separated, ordered `speech_models` list (#95).
      speechModel: 'universal-3-5-pro, universal-2',
    },
  },
  // The provider fetches the audio itself from a signed URL: the bytes never
  // pass through this API. `upload` is for storage the provider cannot reach,
  // which is the exception rather than the default.
  audioDelivery: 'presigned_url',
  // Six hours. It has to outlive the vendor's whole queue-plus-processing time
  // for a long recording; a URL that expires mid-fetch produces a failure that
  // looks like a corrupt file.
  presignedUrlTtlMinutes: 360,
  // ON. Audio sent to a third party is this deployment's responsibility, and
  // leaving it there indefinitely is a retention decision nobody made.
  deleteRemoteAfterIngest: true,
  // `null` means "ask the provider to detect it", which is the right default for
  // a deployment that has not told us what language it works in.
  defaultLanguage: null,
  // ON, unlike `databaseBackup.nodeOffloadEnabled`. Transcoding needs a
  // presigned URL and a CPU, not a credential to this deployment's database, so
  // the trust question the backup's switch answers does not arise.
  transcodeNodeOffloadEnabled: true,
  // Three hours of INACTIVITY (the source upload's `updated_at`, refreshed by
  // every part batch and status poll), not three hours since creation: an upload
  // being actively pushed is never purged (issue #322).
  abandonedUploadHours: 3,
  playback: {
    // 64 kbit/s mono is comfortably intelligible speech at roughly a twentieth
    // the size of the source, which is what a proof-reading rendition is for.
    bitrateKbps: 64,
  },
};
