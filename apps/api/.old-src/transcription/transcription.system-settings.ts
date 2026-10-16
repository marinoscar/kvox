// =============================================================================
// The `transcription` system settings namespace (issue #459, issue #23, epic #19)
// =============================================================================
//
// Speech-to-text policy: the active provider, its region and model, how audio
// reaches it and what happens to it afterwards. Declared HERE, beside the
// module that owns it, and registered by `apps/api/src/app-registrations/settings.ts`
// (`APP_SYSTEM_SETTINGS_NAMESPACES`, with its `SystemSettingsNamespaces`
// augmentation); the platform settings slice composes it into
// `GET/PUT/PATCH /api/system-settings`.
//
// The stored and PATCH shapes are `systemTranscriptionSchema` /
// `systemTranscriptionPatchSchema` from `transcription-settings.schema.ts` (a
// leaf that also carries the compile-time proof that no secret-bearing field
// exists). The PUT and PATCH request-body branches were cut from
// `settings/dto/update-system-settings.dto.ts`, the response branch from
// `system-settings-response.dto.ts`, and the defaults from
// `DEFAULT_SYSTEM_SETTINGS.transcription`.
//
// NO `apiKey` FIELD, HERE OR ANYWHERE IN THIS NAMESPACE. The provider key is
// written through `PUT /api/transcription-settings` into the encrypted
// credential store; a key accepted by a settings body would be persisted into
// the settings blob, which is the exact failure the compile-time proof exists
// to prevent. Registration also walks every schema below for secret-named
// fields.
// =============================================================================

import { z } from 'zod';

import type { SystemSettingsNamespace } from '@marinoscar/platform-api/settings';
import {
  systemTranscriptionPatchSchema,
  systemTranscriptionSchema,
  type SystemTranscriptionValue,
} from './transcription-settings.schema';

/** The PUT branch (optional in the body: an omitted block is carried forward, never reset). */
const transcriptionPutSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['assemblyai']).nullable(),
  providers: z.object({
    assemblyai: z.object({
      region: z.enum(['us', 'eu']),
      speechModel: z.string().trim().min(1).max(64),
    }),
  }),
  audioDelivery: z.enum(['presigned_url', 'upload']),
  presignedUrlTtlMinutes: z.number().int().min(1).max(1440),
  deleteRemoteAfterIngest: z.boolean(),
  defaultLanguage: z.string().trim().min(2).max(16).nullable(),
  transcodeNodeOffloadEnabled: z.boolean(),
  abandonedUploadHours: z.number().int().min(1).max(720),
  playback: z.object({
    bitrateKbps: z.number().int().min(16).max(320),
  }),
});

// `defaultLanguage` is `.nullable().optional()` for the same reason
// `maintenance.startedAt` is: `null` means "detect the language", absent
// means "leave the setting alone", and the service's merge distinguishes
// them with `!== undefined` rather than `??`.
const transcriptionWirePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.enum(['assemblyai']).nullable().optional(),
    providers: z
      .object({
        assemblyai: z
          .object({
            region: z.enum(['us', 'eu']).optional(),
            speechModel: z.string().trim().min(1).max(64).optional(),
          })
          .optional(),
      })
      .optional(),
    audioDelivery: z.enum(['presigned_url', 'upload']).optional(),
    presignedUrlTtlMinutes: z.number().int().min(1).max(1440).optional(),
    deleteRemoteAfterIngest: z.boolean().optional(),
    defaultLanguage: z.string().trim().min(2).max(16).nullable().optional(),
    transcodeNodeOffloadEnabled: z.boolean().optional(),
    abandonedUploadHours: z.number().int().min(1).max(720).optional(),
    playback: z
      .object({
        bitrateKbps: z.number().int().min(16).max(320).optional(),
      })
      .optional(),
  });

/** The response branch. The provider API KEY is deliberately absent and cannot appear here. */
const transcriptionResponseSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['assemblyai']).nullable(),
  providers: z.object({
    assemblyai: z.object({
      region: z.enum(['us', 'eu']),
      speechModel: z.string(),
    }),
  }),
  audioDelivery: z.enum(['presigned_url', 'upload']),
  presignedUrlTtlMinutes: z.number(),
  deleteRemoteAfterIngest: z.boolean(),
  defaultLanguage: z.string().nullable(),
  transcodeNodeOffloadEnabled: z.boolean(),
  abandonedUploadHours: z.number(),
  playback: z.object({
    bitrateKbps: z.number(),
  }),
});

type TranscriptionPatch = z.infer<typeof transcriptionWirePatchSchema>;

/**
 * The `transcription` PATCH merge, field by field (the body of the old
 * `SystemSettingsService.patchSettings` block, moved verbatim by #466): a field
 * the patch names replaces the stored one, an absent field is kept.
 *
 * `provider` and `defaultLanguage` test `!== undefined`, never `??`: an explicit
 * `null` is a VALUE here ("no provider", "detect the language"), so `??` would
 * make clearing either a silent no-op.
 */
export function mergeTranscriptionSettings(
  current: SystemTranscriptionValue,
  patch?: TranscriptionPatch,
): SystemTranscriptionValue {
  return {
    enabled: patch?.enabled ?? current.enabled,
    provider: patch?.provider !== undefined ? patch.provider : current.provider,
    providers: {
      assemblyai: {
        region: patch?.providers?.assemblyai?.region ?? current.providers.assemblyai.region,
        speechModel:
          patch?.providers?.assemblyai?.speechModel ?? current.providers.assemblyai.speechModel,
      },
    },
    audioDelivery: patch?.audioDelivery ?? current.audioDelivery,
    presignedUrlTtlMinutes: patch?.presignedUrlTtlMinutes ?? current.presignedUrlTtlMinutes,
    deleteRemoteAfterIngest: patch?.deleteRemoteAfterIngest ?? current.deleteRemoteAfterIngest,
    defaultLanguage:
      patch?.defaultLanguage !== undefined ? patch.defaultLanguage : current.defaultLanguage,
    transcodeNodeOffloadEnabled:
      patch?.transcodeNodeOffloadEnabled ?? current.transcodeNodeOffloadEnabled,
    abandonedUploadHours: patch?.abandonedUploadHours ?? current.abandonedUploadHours,
    playback: {
      bitrateKbps: patch?.playback?.bitrateKbps ?? current.playback.bitrateKbps,
    },
  };
}

export const TRANSCRIPTION_SYSTEM_SETTINGS: SystemSettingsNamespace<
  'transcription',
  SystemTranscriptionValue,
  TranscriptionPatch
> = {
  key: 'transcription',
  description: 'Speech-to-text policy: active provider, region and model, audio delivery and retention.',
  storedSchema: systemTranscriptionSchema,
  patchSchema: systemTranscriptionPatchSchema,
  putSchema: transcriptionPutSchema,
  wirePatchSchema: transcriptionWirePatchSchema,
  responseSchema: transcriptionResponseSchema,
  // INERT, like every operations default: `enabled: false` and `provider: null`
  // mean an upgrade changes nothing until an administrator chooses a vendor and
  // saves a key. The per-provider block is still fully populated, so choosing
  // AssemblyAI is one field rather than four.
  defaults: {
    enabled: false,
    provider: null,
    providers: {
      assemblyai: {
        region: 'us',
        // A comma-separated, ordered `speech_models` list (#95).
        speechModel: 'universal-3-5-pro, universal-2',
      },
    },
    // The provider fetches the audio itself from a signed URL — the bytes
    // never pass through this API. `upload` is for storage the provider
    // cannot reach, which is the exception rather than the default.
    audioDelivery: 'presigned_url',
    // Six hours. It has to outlive the vendor's whole queue-plus-processing
    // time for a long recording; a URL that expires mid-fetch produces a
    // failure that looks like a corrupt file.
    presignedUrlTtlMinutes: 360,
    // ON. Audio sent to a third party is this deployment's responsibility, and
    // leaving it there indefinitely is a retention decision nobody made.
    deleteRemoteAfterIngest: true,
    // `null` means "ask the provider to detect it", which is the right default
    // for a deployment that has not told us what language it works in.
    defaultLanguage: null,
    // ON, unlike `databaseBackup.nodeOffloadEnabled`. Transcoding needs a
    // presigned URL and a CPU, not a credential to this deployment's database
    // — so the trust question the backup's switch answers does not arise.
    transcodeNodeOffloadEnabled: true,
    // Three hours of INACTIVITY (the source upload's `updated_at`, refreshed
    // by every part batch and status poll), not three hours since creation —
    // an upload being actively pushed is never purged (issue #322).
    abandonedUploadHours: 3,
    playback: {
      // 64 kbit/s mono is comfortably intelligible speech at roughly a
      // twentieth the size of the source, which is what a proof-reading
      // rendition is for.
      bitrateKbps: 64,
    },
  },
  requiredOnPut: false,
  merge: mergeTranscriptionSettings,
};
