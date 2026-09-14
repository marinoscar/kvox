import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { notificationEventKeySchema } from '../../common/schemas/user-settings-namespaces.schema';
import {
  MAX_DISABLED_NOTIFICATION_EVENTS,
  BACKUP_TIME_OF_DAY_PATTERN,
} from '../../common/schemas/settings.schema';

// The request-body schemas deliberately RESTATE `common/schemas/settings.schema.ts`
// rather than importing it: these are the OpenAPI-visible DTOs (`createZodDto`
// reads them to build the documented request schema) and the service validates
// against the shared schema again on the way in. Both copies must move together
// — `notifications` (#225) is the block that most recently did.

/**
 * Deployment-wide browser-notification policy (#225, epic #215).
 *
 * A MODELLED block: a framework-level, security-adjacent gate needs a real
 * type, a real default and somewhere to document its semantics. Nothing enforces it yet — the browser
 * channel reading these values is issue #226 — so it is stored and editable and
 * no delivery path consults it. See `systemNotificationsSchema`.
 */
const notificationsSettingsSchema = z.object({
  browserEnabled: z.boolean(),
  disabledEvents: z
    .array(notificationEventKeySchema)
    .max(MAX_DISABLED_NOTIFICATION_EVENTS),
});

// =============================================================================
// Operations namespaces on the wire (#256, epic #254)
// =============================================================================
//
// THIS FILE IS THE TRAP THE PARITY GUARD EXISTS FOR. A namespace that reaches
// `systemSettingsSchema` but not the two schemas below is not a validation
// error — it is a SILENT one. The global `ZodValidationPipe` parses the body
// against these schemas first and strips every key they do not declare, so the
// service is handed a body with the caller's change already deleted and
// cheerfully writes the unchanged value back. `common/schemas/settings-parity.spec.ts`
// fails the build when that happens; read its header before editing anything
// here.
//
// WHY THESE FOUR ARE OPTIONAL IN THE PUT BODY WHILE `notifications` IS REQUIRED.
// The rule `notifications` (#225) established is right and unchanged: a PUT
// that omits a modelled block must not silently reset it. The two cases differ
// in who is sending the body. `notifications` shipped together with the admin
// UI that sends it, so requiring it broke nothing and caught real omissions.
// These four ship AHEAD of every consumer, so requiring them would 400 every
// PUT from every client that exists today — including this repo's own settings
// page — the moment this issue merges. That is exactly the "changes behaviour
// for a deployment that has never saved these keys" outcome the issue rules
// out.
//
// SO WHAT STOPS THE SILENT RESET? `replaceSettings` carries an omitted block
// forward from the stored value instead of letting it fall back to the
// defaults — the same rule that file already applies to keys it does not model
// at all, and it is derived from THIS schema (the keys that accept
// `undefined`), not from a second hand-written list. A PUT can therefore change
// these namespaces, but cannot erase them by not mentioning them. When a UI for
// one of them lands and every client is sending it, promoting that block to
// required here is a one-line change with a test that already covers it.

const jobsSettingsSchema = z.object({
  history: z.object({
    retentionDays: z.number().int().min(1).max(3650),
    purgeEnabled: z.boolean(),
  }),
  stuckThresholdMinutes: z.number().int().min(1).max(10080),
});

const nodesSettingsSchema = z.object({
  staleHeartbeatSeconds: z.number().int().min(5).max(86400),
  offlineStaleMultiplier: z.number().int().min(1).max(100),
  offlineRetentionDays: z.number().int().min(1).max(3650),
  jobSecretBrokerEnabled: z.boolean(),
});

const databaseBackupSettingsSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  dayOfWeek: z.number().int().min(0).max(6),
  dayOfMonth: z.number().int().min(1).max(28),
  timeOfDay: z
    .string()
    .regex(BACKUP_TIME_OF_DAY_PATTERN, 'Expected a 24-hour HH:MM time'),
  timezone: z.string().min(1).max(64),
  retentionCount: z.number().int().min(1).max(365),
  storageProvider: z.string().min(1).max(64),
  runStaleMinutes: z.number().int().min(1).max(10080),
  compressionLevel: z.number().int().min(0).max(9),
  restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
  oldDatabaseRetentionHours: z.number().int().min(1).max(8760),
  nodeOffloadEnabled: z.boolean(),
});

const maintenanceSettingsSchema = z.object({
  enabled: z.boolean(),
  message: z.string().min(1).max(1000),
  allowAdmins: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  startedById: z.string().uuid().nullable(),
});

/**
 * Transcription (#23, epic #19).
 *
 * RESTATED HERE rather than imported from `transcription-settings.schema.ts`,
 * exactly like the four blocks above and for the reason at the top of this
 * file: these are the OpenAPI-visible request schemas that `createZodDto`
 * reads, and the service validates against the shared schema again on the way
 * in. The two copies must move together — `common/schemas/settings-parity.spec.ts`
 * is what fails the build when they do not.
 *
 * NO `apiKey` FIELD, HERE OR ANYWHERE IN THIS NAMESPACE. The provider key is
 * written through `PUT /api/transcription-settings` into the encrypted
 * credential store; a key accepted by THIS body would be persisted into the
 * settings blob, which is the exact failure
 * `transcription-settings.schema.ts`'s compile-time proof exists to prevent.
 */
const transcriptionSettingsSchema = z.object({
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
  playback: z.object({
    bitrateKbps: z.number().int().min(16).max(320),
  }),
});

/**
 * AI policy (#47, epic #45).
 *
 * RESTATED HERE rather than imported from `ai/ai-settings.schema.ts`, exactly
 * like the five blocks above and for the reason at the top of this file: these
 * are the OpenAPI-visible request schemas that `createZodDto` reads, and the
 * service validates against the shared schema again on the way in. The two
 * copies must move together — `common/schemas/settings-parity.spec.ts` is what
 * fails the build when they do not.
 *
 * ⚠ NO `apiKey` FIELD, HERE OR ANYWHERE IN THIS NAMESPACE — and in this epic
 * not even a write-only one, because there is no deployment AI key at all.
 * Every AI key belongs to an individual user and is written through
 * `PUT /api/ai-credentials` into `user_ai_credentials`. A key accepted by THIS
 * body would be persisted into the settings blob, which is the exact failure
 * `ai-settings.schema.ts`'s compile-time proof exists to prevent.
 */
const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  // The ACTIVE provider (#78), nullable exactly as `transcription.provider`
  // above is: `null` is the persisted "nobody has chosen one", not an absent
  // key. Missing this line would make a full PUT silently drop the vendor
  // choice, which `SystemSettingsService.replaceSettings` would then carry
  // forward blind.
  provider: z.enum(['openai']).nullable(),
  providers: z.object({
    openai: z.object({
      baseUrl: z.string().trim().url().max(512),
      allowedModels: z.array(z.string().trim().min(1).max(128)).max(50),
      defaultModel: z.string().trim().min(1).max(128),
    }),
  }),
  maxInputTokens: z.number().int().min(256).max(2_000_000),
  maxOutputTokens: z.number().int().min(64).max(200_000),
  requestTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  // Ceiling on one uploaded note source document, in bytes (#51). See
  // `ai-settings.schema.ts` for why an AI policy and not a storage one.
  maxDocumentBytes: z.number().int().min(65_536).max(268_435_456),
});

// Full replacement (PUT)
export const updateSystemSettingsSchema = z.object({
  // REQUIRED. A PUT that omits it is a 400 and
  // not a silent reset to the defaults: the value it would reset is an
  // operator's decision to turn a delivery channel off for everyone.
  notifications: notificationsSettingsSchema,
  // OPTIONAL — see the section header above. Omitting one means "leave it as
  // stored", never "reset it to the defaults"; `SystemSettingsService
  // .replaceSettings` is what makes that true.
  jobs: jobsSettingsSchema.optional(),
  nodes: nodesSettingsSchema.optional(),
  databaseBackup: databaseBackupSettingsSchema.optional(),
  maintenance: maintenanceSettingsSchema.optional(),
  transcription: transcriptionSettingsSchema.optional(),
  ai: aiSettingsSchema.optional(),
});

export class UpdateSystemSettingsDto extends createZodDto(
  updateSystemSettingsSchema,
) {}

// Partial update (PATCH)
export const patchSystemSettingsSchema = z.object({
  // `disabledEvents` REPLACES rather than merges — RFC 7396's rule for arrays,
  // and the only workable one here: a merging list could never express
  // "re-enable this event", so unchecking a box on the admin page would be a
  // no-op.
  notifications: z
    .object({
      browserEnabled: z.boolean().optional(),
      disabledEvents: z
        .array(notificationEventKeySchema)
        .max(MAX_DISABLED_NOTIFICATION_EVENTS)
        .optional(),
    })
    .optional(),
  // Optional at the namespace level and field by field inside, so that
  // `{ "databaseBackup": { "enabled": true } }` is a legal body. If this line
  // is missing, that body parses to `{}` and the PATCH is a no-op that returns
  // 200 — the defect `settings-parity.spec.ts` and
  // `test/settings/system-settings.integration.spec.ts` both pin.
  jobs: z
    .object({
      history: z
        .object({
          retentionDays: z.number().int().min(1).max(3650).optional(),
          purgeEnabled: z.boolean().optional(),
        })
        .optional(),
      stuckThresholdMinutes: z.number().int().min(1).max(10080).optional(),
    })
    .optional(),
  nodes: z
    .object({
      staleHeartbeatSeconds: z.number().int().min(5).max(86400).optional(),
      offlineStaleMultiplier: z.number().int().min(1).max(100).optional(),
      offlineRetentionDays: z.number().int().min(1).max(3650).optional(),
      jobSecretBrokerEnabled: z.boolean().optional(),
    })
    .optional(),
  databaseBackup: z
    .object({
      enabled: z.boolean().optional(),
      frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
      dayOfMonth: z.number().int().min(1).max(28).optional(),
      timeOfDay: z
        .string()
        .regex(BACKUP_TIME_OF_DAY_PATTERN, 'Expected a 24-hour HH:MM time')
        .optional(),
      timezone: z.string().min(1).max(64).optional(),
      retentionCount: z.number().int().min(1).max(365).optional(),
      storageProvider: z.string().min(1).max(64).optional(),
      runStaleMinutes: z.number().int().min(1).max(10080).optional(),
      compressionLevel: z.number().int().min(0).max(9).optional(),
      restoreRollbackMode: z
        .enum(['retain_database', 'drop_database'])
        .optional(),
      oldDatabaseRetentionHours: z.number().int().min(1).max(8760).optional(),
      nodeOffloadEnabled: z.boolean().optional(),
    })
    .optional(),
  // `startedAt` and `startedById` are `.nullable().optional()`: `null` clears
  // the window's provenance, absent leaves it alone. The service's merge
  // distinguishes the two with `!== undefined` rather than `??`, which would
  // collapse them and make "clear it" impossible to express.
  maintenance: z
    .object({
      enabled: z.boolean().optional(),
      message: z.string().min(1).max(1000).optional(),
      allowAdmins: z.boolean().optional(),
      startedAt: z.iso.datetime().nullable().optional(),
      startedById: z.string().uuid().nullable().optional(),
    })
    .optional(),
  // `defaultLanguage` is `.nullable().optional()` for the same reason
  // `maintenance.startedAt` is: `null` means "detect the language", absent
  // means "leave the setting alone", and the service's merge distinguishes
  // them with `!== undefined` rather than `??`.
  transcription: z
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
      playback: z
        .object({
          bitrateKbps: z.number().int().min(16).max(320).optional(),
        })
        .optional(),
    })
    .optional(),
  // AI policy (#47, epic #45). Optional at the namespace level and field by
  // field inside, so `{ "ai": { "enabled": true } }` is a legal body. If this
  // branch were missing, that body would parse to `{}` and the PATCH would be
  // a no-op returning 200 — the exact defect `settings-parity.spec.ts` exists
  // to catch. `allowedModels` REPLACES wholesale rather than merging, RFC
  // 7396's rule for arrays and the only one that can express "stop permitting
  // this model".
  ai: z
    .object({
      enabled: z.boolean().optional(),
      // `.nullable().optional()` for the reason `transcription.provider` and
      // `maintenance.startedAt` are (#78): `null` means "no provider is
      // active" and absent means "leave the choice alone", and the service's
      // merge distinguishes them with `!== undefined` rather than `??`.
      provider: z.enum(['openai']).nullable().optional(),
      providers: z
        .object({
          openai: z
            .object({
              baseUrl: z.string().trim().url().max(512).optional(),
              allowedModels: z
                .array(z.string().trim().min(1).max(128))
                .max(50)
                .optional(),
              defaultModel: z.string().trim().min(1).max(128).optional(),
            })
            .optional(),
        })
        .optional(),
      maxInputTokens: z.number().int().min(256).max(2_000_000).optional(),
      maxOutputTokens: z.number().int().min(64).max(200_000).optional(),
      requestTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
      maxDocumentBytes: z.number().int().min(65_536).max(268_435_456).optional(),
    })
    .optional(),
});

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}
