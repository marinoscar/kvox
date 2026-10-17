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

/**
 * The body of `PUT /api/transcription-settings`.
 *
 * @stability experimental
 */
export class UpdateTranscriptionSettingsDto extends createZodDto(
  updateTranscriptionSettingsSchema,
) {}

/**
 * The body of `POST /api/transcription-settings/test`.
 *
 * @stability experimental
 */
export class TestTranscriptionConnectionDto extends createZodDto(
  testTranscriptionConnectionSchema,
) {}

/**
 * The response of `GET` and `PUT /api/transcription-settings`.
 *
 * @stability experimental
 */
export class TranscriptionSettingsResponseDto extends createZodDto(
  transcriptionSettingsResponseSchema,
) {}

/**
 * The response of `POST /api/transcription-settings/test`.
 *
 * @stability experimental
 */
export class TranscriptionConnectionTestDto extends createZodDto(
  transcriptionConnectionTestSchema,
) {}

/**
 * The response of `GET /api/transcription/config`.
 *
 * @stability experimental
 */
export class TranscriptionConfigDto extends createZodDto(
  transcriptionConfigSchema,
) {}
