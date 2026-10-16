import { createZodDto } from 'nestjs-zod';
import {
  updateTranscriptionSettingsSchema,
  testTranscriptionConnectionSchema,
  transcriptionSettingsResponseSchema,
  transcriptionConnectionTestSchema,
  transcriptionConfigSchema,
} from '@marinoscar/kvox-contract/transcription';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/transcription` (issue #488, file `transcription/transcription-settings.ts`); they are re-exported below so no importer changes.
export {
  updateTranscriptionSettingsSchema,
  type UpdateTranscriptionSettingsBody,
  testTranscriptionConnectionSchema,
  providerKeyStatusSchema,
  providerFieldDescriptorSchema,
  providerCapabilitiesSchema,
  transcriptionProviderDescriptionSchema,
  transcriptionSettingsResponseSchema,
  transcriptionConnectionTestSchema,
  transcriptionConfigSchema,
  type TranscriptionConfigResponse,
} from '@marinoscar/kvox-contract/transcription';

export class UpdateTranscriptionSettingsDto extends createZodDto(
  updateTranscriptionSettingsSchema,
) {}

export class TestTranscriptionConnectionDto extends createZodDto(
  testTranscriptionConnectionSchema,
) {}

export class TranscriptionSettingsResponseDto extends createZodDto(
  transcriptionSettingsResponseSchema,
) {}

export class TranscriptionConnectionTestDto extends createZodDto(
  transcriptionConnectionTestSchema,
) {}

export class TranscriptionConfigDto extends createZodDto(
  transcriptionConfigSchema,
) {}
