// The host-neutral half of the transcription slice: the admin API client and
// the hook over it. No component, no `@mui/*`.

export {
  getTranscriptionConfig,
  getTranscriptionSettings,
  removeTranscriptionCredential,
  testTranscriptionConnection,
  updateTranscriptionSettings,
} from './transcription-client.js';
export type {
  AssemblyAiRegion,
  AudioDeliveryMode,
  ProviderFieldDescriptor,
  ProviderFieldOption,
  ProviderKeyStatus,
  TestTranscriptionConnectionInput,
  TranscriptionConfig,
  TranscriptionConnectionTest,
  TranscriptionProviderCapabilities,
  TranscriptionProviderDescription,
  TranscriptionProviderId,
  TranscriptionSettings,
  TranscriptionSettingsActor,
  TranscriptionSettingsAdminView,
  UpdateTranscriptionSettingsInput,
} from './transcription-client.js';
export { useTranscriptionSettings } from './useTranscriptionSettings.js';
export type { UseTranscriptionSettingsReturn } from './useTranscriptionSettings.js';
