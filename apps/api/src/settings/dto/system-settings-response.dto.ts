import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const systemSettingsResponseSchema = z.object({
  security: z.object({
    jwtAccessTtlMinutes: z.number(),
    refreshTtlDays: z.number(),
  }),
  // #225, epic #215. Part of the represented resource, which is what makes a
  // PUT that omits it meaningful (and rejected) rather than a client simply not
  // knowing the field exists. Nothing enforces these values yet — that is #226.
  notifications: z.object({
    browserEnabled: z.boolean(),
    disabledEvents: z.array(z.string()),
  }),
  // #256, epic #254 — the operations namespaces. Published from the day they
  // exist rather than the day something reads them: a block the response omits
  // is a block no client can echo back in a PUT, which would leave
  // `replaceSettings` carrying it forward blind forever. Restated here rather
  // than imported for the same reason the request bodies are — this is the
  // OpenAPI-visible contract — and kept in step by
  // `common/schemas/settings-parity.spec.ts`.
  jobs: z.object({
    history: z.object({
      retentionDays: z.number(),
      purgeEnabled: z.boolean(),
    }),
    stuckThresholdMinutes: z.number(),
  }),
  nodes: z.object({
    staleHeartbeatSeconds: z.number(),
    offlineStaleMultiplier: z.number(),
    offlineRetentionDays: z.number(),
    jobSecretBrokerEnabled: z.boolean(),
  }),
  databaseBackup: z.object({
    enabled: z.boolean(),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    dayOfWeek: z.number(),
    dayOfMonth: z.number(),
    timeOfDay: z.string(),
    timezone: z.string(),
    retentionCount: z.number(),
    storageProvider: z.string(),
    runStaleMinutes: z.number(),
    compressionLevel: z.number(),
    restoreRollbackMode: z.enum(['retain_database', 'drop_database']),
    oldDatabaseRetentionHours: z.number(),
    nodeOffloadEnabled: z.boolean(),
  }),
  maintenance: z.object({
    enabled: z.boolean(),
    message: z.string(),
    allowAdmins: z.boolean(),
    startedAt: z.string().nullable(),
    startedById: z.string().nullable(),
  }),
  // #23, epic #19. Published from the day the namespace exists, for the reason
  // the operations blocks above are: a block the response omits is a block no
  // client can echo back in a PUT, which would leave `replaceSettings`
  // carrying it forward blind forever. The provider API KEY is deliberately
  // absent and cannot appear here — it is never part of this namespace.
  transcription: z.object({
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
    playback: z.object({
      bitrateKbps: z.number(),
    }),
  }),
  // #47, epic #45. Published from the day the namespace exists, for the reason
  // every block above is: a block the response omits is a block no client can
  // echo back in a PUT, which would leave `replaceSettings` carrying it forward
  // blind forever.
  //
  // ⚠ NO API KEY IS PART OF THIS NAMESPACE AND NONE CAN APPEAR HERE. Unlike
  // `transcription`, there is not even a deployment key elsewhere: every AI key
  // belongs to an individual user and lives in `user_ai_credentials`.
  ai: z.object({
    enabled: z.boolean(),
    provider: z.enum(['openai']).nullable(),
    providers: z.object({
      openai: z.object({
        baseUrl: z.string(),
        allowedModels: z.array(z.string()),
        defaultModel: z.string(),
      }),
    }),
    maxInputTokens: z.number(),
    maxOutputTokens: z.number(),
    requestTimeoutMs: z.number(),
    maxDocumentBytes: z.number(),
  }),
  updatedAt: z.iso.datetime(),
  updatedBy: z
    .object({
      id: z.string().uuid(),
      email: z.string().email(),
    })
    .nullable(),
  version: z.number(),
});

export class SystemSettingsResponseDto extends createZodDto(
  systemSettingsResponseSchema,
) {}
