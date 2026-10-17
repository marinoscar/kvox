// The transcription slice of @marinoscar/kvox-api (issue #492, epic #491).
//
// Depends on `ports` and `core` only. The one way in is
// `TranscriptionModule.forRoot(options)`.

export { TranscriptionModule } from './transcription.module.js';
export {
  DEFAULT_TRANSCRIPTION_PERMISSIONS,
  TRANSCRIPTION_EXTRA_PROVIDERS,
  type TranscriptionBuiltInProviders,
  type TranscriptionModuleOptions,
  type TranscriptionPermissionOptions,
} from './transcription.options.js';

export { TranscriptionProviderRegistry } from './transcription-provider.registry.js';
export {
  TranscriptionSettingsService,
  type ProviderKeyStatus,
  type TestTranscriptionConnectionInput,
  type TranscriptionSettingsAdminView,
  type TranscriptionSettingsPatch,
  type UpdateTranscriptionSettingsInput,
} from './transcription-settings.service.js';
export { TranscriptionConfigService } from './transcription-config.service.js';
export { TranscriptionSettingsController } from './transcription-settings.controller.js';
export { TranscriptionConfigController } from './transcription-config.controller.js';

export {
  ProviderAuthError,
  ProviderInputError,
  RateLimitError,
  isTerminalProviderError,
} from './errors.js';

export {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  TRANSCRIPTION_CREDENTIAL_PURPOSE_LABEL,
  transcriptionCredentialLabel,
  transcriptionCredentialName,
} from './transcription-credential.constants.js';

export {
  createProviderContext,
  type TranscriptionProviderContext,
} from './provider-context.js';

export {
  MAX_KEYTERM_LENGTH,
  MAX_KEYTERM_WORDS,
  MAX_TRANSCRIPT_KEYTERMS,
  clampKeytermsToCapability,
  keytermWordCount,
  maxKeytermsFor,
  normalizeKeyterms,
  readKeyterms,
} from './keyterms.js';

export {
  FALLBACK_WORDS_PER_SEGMENT,
  MAX_SEGMENT_MS,
  collectSpeakers,
  endsSentence,
  partitionWords,
  splitLongSegment,
  splitLongSegments,
  type NormalizedSegment,
  type NormalizedSpeaker,
  type NormalizedTranscript,
  type NormalizedTranscriptProvider,
  type NormalizedWord,
} from './normalized-transcript.js';

export type {
  ProviderFieldDescriptor,
  ProviderFieldOption,
  TranscriptionAudioSource,
  TranscriptionConnectionTest,
  TranscriptionKeytermsCapability,
  TranscriptionOptions,
  TranscriptionProvider,
  TranscriptionProviderCapabilities,
  TranscriptionProviderDescription,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptionStatus,
  TranscriptionSubmitResult,
} from './providers/transcription-provider.interface.js';

export {
  ASSEMBLYAI_DEFAULT_SPEECH_MODELS,
  ASSEMBLYAI_FETCH,
  ASSEMBLYAI_MAX_KEYTERMS,
  ASSEMBLYAI_MAX_WORDS_PER_KEYTERM,
  ASSEMBLYAI_PROVIDER_ID,
  AssemblyAiProvider,
  type AssemblyAiSettings,
  type FetchLike,
  type FetchLikeHeaders,
  type FetchLikeResponse,
} from './providers/assemblyai.provider.js';

export {
  ASSEMBLYAI_REGIONS,
  ASSEMBLYAI_SETTINGS_CARRY_NO_SECRET,
  AUDIO_DELIVERY_MODES,
  TRANSCRIPTION_PROVIDER_IDS,
  TRANSCRIPTION_SETTINGS_CARRIES_NO_SECRET,
  TRANSCRIPTION_SETTINGS_DEFAULTS,
  systemTranscriptionPatchSchema,
  systemTranscriptionSchema,
  transcriptionPlaybackSchema,
  transcriptionProviderIdSchema,
  transcriptionProvidersSchema,
  type AssemblyAiRegion,
  type AssemblyAiSettingsCarryNoSecret,
  type AudioDeliveryMode,
  type SystemTranscriptionValue,
  type TranscriptionPlaybackValue,
  type TranscriptionProviderId,
  type TranscriptionProvidersValue,
  type TranscriptionSettingsCarriesNoSecret,
} from './transcription-settings.schema.js';

export {
  TestTranscriptionConnectionDto,
  TranscriptionConfigDto,
  TranscriptionConnectionTestDto,
  TranscriptionSettingsResponseDto,
  UpdateTranscriptionSettingsDto,
  type TranscriptionConfigResponse,
} from './dto/transcription-settings.dto.js';
